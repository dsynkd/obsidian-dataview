/** Stores various indices on all files in the vault to make dataview generation fast. */
import { Result } from "api/result";
import { parseCsv } from "data-import/csv";
import { LocalStorageCache } from "data-import/persister";
import { FileImporter } from "data-import/web-worker/import-manager";
import { PageMetadata } from "data-model/markdown";
import { DataObject } from "data-model/value";
import { DateTime } from "luxon";
import { App, Component, MetadataCache, TAbstractFile, TFile, TFolder, Vault } from "obsidian";
import { getParentFolder, setsEqual } from "util/normalize";
import {
    buildDiskSnapshotObject,
    DiskSnapshotFileV1,
    snapshotDataToPartial,
} from "data-index/disk-snapshot";

/** Aggregate index which has several sub-indices and will initialize all of them. */
export class FullIndex extends Component {
    /** Generate a full index from the given vault. */
    public static create(
        app: App,
        indexVersion: string,
        onChange: () => void,
        requestPersistDiskSnapshot?: () => void,
        writeIndexSnapshot?: (snapshot: DiskSnapshotFileV1 | null) => Promise<void>
    ): FullIndex {
        return new FullIndex(app, indexVersion, onChange, requestPersistDiskSnapshot, writeIndexSnapshot);
    }

    /**
     * When true, the index snapshot is merged into the plugin's `data.json` (debounced) and read on startup when the
     * Dataview version and per-file mtimes match.
     */
    public diskIndexPersistence: boolean = false;

    /** Snapshot from the last `loadData()` call; consumed during the first `_initialize`. */
    private startupEmbeddedSnapshot: DiskSnapshotFileV1 | undefined;

    /** Set before `initialize()` when loading snapshot from `data.json`. */
    public setStartupEmbeddedSnapshot(snap: DiskSnapshotFileV1 | undefined): void {
        this.startupEmbeddedSnapshot = snap;
    }

    /** When set, in-memory updates do not enqueue a debounced disk snapshot (used during full re-index). */
    private suspendDiskSnapshotPersist: boolean = false;

    /** Whether all files in the vault have been indexed at least once. */
    public initialized: boolean;

    /** I/O access to the Obsidian vault contents. */
    public vault: Vault;
    /** Access to in-memory metadata, useful for parsing and metadata lookups. */
    public metadataCache: MetadataCache;
    /** Persistent IndexedDB backing store, used for faster startup. */
    public persister: LocalStorageCache;

    /* Maps path -> markdown metadata for all markdown pages. */
    public pages: Map<string, PageMetadata>;

    /** Map files -> tags in that file, and tags -> files. This version includes subtags. */
    public tags: ValueCaseInsensitiveIndexMap;
    /** Map files -> exact tags in that file, and tags -> files. This version does not automatically add subtags. */
    public etags: ValueCaseInsensitiveIndexMap;
    /** Map files -> linked files in that file, and linked file -> files that link to it. */
    public links: IndexMap;
    /** Search files by path prefix. */
    public prefix: PrefixIndex;
    /** Allows for efficient lookups of whether a file is starred or not. */
    public starred: StarredCache;
    /** Caches data in CSV files. */
    // TODO: CSV parsing should be done by a worker thread asynchronously to avoid frontend stalls.
    public csv: CsvCache;

    /**
     * The current "revision" of the index, which monotonically increases for every index change. Use this to determine
     * if you are up to date.
     */
    public revision: number;

    /** Asynchronously parses files in the background using web workers. */
    public importer: FileImporter;

    /** Construct a new index using the app data and a current data version. */
    private constructor(
        public app: App,
        public indexVersion: string,
        public onChange: () => void,
        private requestPersistDiskSnapshot?: () => void,
        private writeIndexSnapshot?: (snapshot: DiskSnapshotFileV1 | null) => Promise<void>
    ) {
        super();

        this.initialized = false;

        this.vault = app.vault;
        this.metadataCache = app.metadataCache;

        this.pages = new Map();
        this.tags = new ValueCaseInsensitiveIndexMap();
        this.etags = new ValueCaseInsensitiveIndexMap();
        this.links = new IndexMap();
        this.revision = 0;

        // Caches metadata via durable storage to speed up cache initialization when Obsidian restarts.
        this.persister = new LocalStorageCache(app.appId || "shared", indexVersion);

        // Handles asynchronous reloading of files on web workers.
        this.addChild((this.importer = new FileImporter(2, this.vault, this.metadataCache)));
        // Prefix listens to file creation/deletion/rename, and not modifies, so we let it set up it's own listeners.
        this.addChild((this.prefix = PrefixIndex.create(this.vault, () => this.touch())));
        // The CSV cache also needs to listen to filesystem events for cache invalidation.
        this.addChild((this.csv = new CsvCache(this.vault)));
        // The starred cache fetches starred entries semi-regularly via an interval.
        this.addChild((this.starred = new StarredCache(this.app, () => this.touch())));
    }

    /** Trigger a metadata event on the metadata cache. */
    private trigger(...args: any[]): void {
        this.metadataCache.trigger("dataview:metadata-change", ...args);
    }

    /** "Touch" the index, incrementing the revision number and causing downstream views to reload. */
    public touch() {
        this.revision += 1;
        this.onChange();
    }

    /** Runs through the whole vault to set up initial file metadata. */
    public initialize() {
        // The metadata cache is updated on initial file index and file loads.
        this.registerEvent(this.metadataCache.on("resolve", file => this.reload(file)));

        // Renames do not set off the metadata cache; catch these explicitly.
        this.registerEvent(this.vault.on("rename", this.rename, this));

        // File creation does cause a metadata change, but deletes do not. Clear the caches for this.
        this.registerEvent(
            this.vault.on("delete", af => {
                if (!(af instanceof TFile) || !PathFilters.markdown(af.path)) return;
                let file = af as TFile;

                this.pages.delete(file.path);
                this.tags.delete(file.path);
                this.etags.delete(file.path);
                this.links.delete(file.path);

                this.touch();
                this.trigger("delete", file);
            })
        );

        // Asynchronously initialize actual content in the background.
        this._initialize(this.vault.getMarkdownFiles());
    }

    /** Drops the local storage cache and re-indexes all files; this should generally be used if you expect cache issues. */
    public async reinitialize() {
        this.suspendDiskSnapshotPersist = true;
        try {
            await this.persister.recreate();
            await this.clearPersistedIndexSnapshot();

            const files = this.vault.getMarkdownFiles();
            const start = Date.now();
            let promises = files.map(file => this.reload(file));

            await Promise.all(promises);
            console.log(`Dataview: re-initialized index with ${files.length} files (${(Date.now() - start) / 1000.0}s)`);
        } finally {
            this.suspendDiskSnapshotPersist = false;
            if (this.diskIndexPersistence) await this.saveDiskSnapshot();
        }
    }

    /** Internal asynchronous initializer. */
    private async _initialize(files: TFile[]) {
        let reloadStart = Date.now();

        let fromDisk = new Set<string>();
        if (this.diskIndexPersistence) fromDisk = this.tryHydrateFromEmbeddedSnapshot(files);

        let diskHydrated = fromDisk.size;
        let promises = files.map(l =>
            fromDisk.has(l.path) ? Promise.resolve({ cached: false, skipped: false }) : this.reload(l)
        );
        let results = await Promise.all(promises);

        let cached = 0,
            skipped = 0;
        for (let item of results) {
            if (item.skipped) {
                skipped += 1;
                continue;
            }

            if (item.cached) cached += 1;
        }

        this.initialized = true;
        this.metadataCache.trigger("dataview:index-ready");
        console.log(
            `Dataview: all ${files.length} files have been indexed in ${
                (Date.now() - reloadStart) / 1000.0
            }s (${cached} cached, ${skipped} skipped${diskHydrated ? `, ${diskHydrated} from data.json snapshot` : ""}).`
        );

        // Drop keys for files which do not exist anymore.
        let remaining = await this.persister.synchronize(files.map(l => l.path));
        if (remaining.size > 0) {
            console.log(`Dataview: Dropped cache entries for ${remaining.size} deleted files.`);
        }

        if (this.diskIndexPersistence) await this.saveDiskSnapshot();
    }

    /** Write the in-memory index into plugin `data.json` via the host (if persistence is enabled). */
    public async saveDiskSnapshot(): Promise<void> {
        if (!this.diskIndexPersistence || !this.initialized) return;
        try {
            await this.writeIndexSnapshot?.(buildDiskSnapshotObject(this.indexVersion, this.pages));
        } catch (e) {
            console.error("Dataview: failed to save index snapshot to data.json", e);
        }
    }

    /** Drop the snapshot from plugin `data.json` (e.g. when clearing cache or disabling the option). */
    public async clearPersistedIndexSnapshot(): Promise<void> {
        try {
            await this.writeIndexSnapshot?.(null);
        } catch (e) {
            console.error("Dataview: failed to clear index snapshot in data.json", e);
        }
    }

    /** Load matching pages from the embedded `data.json` snapshot into memory without re-parsing. */
    private tryHydrateFromEmbeddedSnapshot(files: TFile[]): Set<string> {
        let empty = new Set<string>();
        if (files.length === 0) return empty;

        let snap = this.startupEmbeddedSnapshot;
        this.startupEmbeddedSnapshot = undefined;
        if (!snap || snap.dataviewVersion !== this.indexVersion) return empty;

        let loaded = new Set<string>();
        for (let file of files) {
            let entry = snap.files[file.path];
            if (!entry) continue;
            if (entry.mtime !== file.stat.mtime) continue;

            try {
                let partial = snapshotDataToPartial(entry.data);
                if (!partial.path) partial.path = file.path;
                this.finishQuiet(file, partial);
                loaded.add(file.path);
            } catch {
                // Corrupt entry; fall back to normal indexing for this file.
            }
        }

        if (loaded.size === 0) return empty;

        this.touch();
        return loaded;
    }

    public rename(file: TAbstractFile, oldPath: string) {
        if (!(file instanceof TFile) || !PathFilters.markdown(file.path)) return;

        if (this.pages.has(oldPath)) {
            const oldMeta = this.pages.get(oldPath);
            this.pages.delete(oldPath);
            if (oldMeta) {
                oldMeta.path = file.path;
                this.pages.set(file.path, oldMeta);
            }
        }

        this.tags.rename(oldPath, file.path);
        this.links.rename(oldPath, file.path);
        this.etags.rename(oldPath, file.path);

        this.touch();
        this.trigger("rename", file, oldPath);
    }

    /** Queue a file for reloading; this is done asynchronously in the background and may take a few seconds. */
    public async reload(file: TFile): Promise<{ cached: boolean; skipped: boolean }> {
        if (!PathFilters.markdown(file.path)) return { cached: false, skipped: true };

        // The first load of a file is attempted from persisted cache; subsequent loads just use the importer.
        if (this.pages.has(file.path) || this.initialized) {
            await this.import(file);
            return { cached: false, skipped: false };
        } else {
            // Check the cache for the latest data; if it is out of date or non-existent, then reload.
            return this.persister.loadFile(file.path).then(async cached => {
                if (!cached || cached.time < file.stat.mtime || cached.version != this.indexVersion) {
                    // This cache value is out of data, reload via the importer and update the cache.
                    // We will skip files with no active file metadata - they will be caught by a later reload
                    // via the 'resolve' metadata event.
                    let fileCache = this.metadataCache.getFileCache(file);
                    if (fileCache === undefined || fileCache === null) return { cached: false, skipped: true };

                    await this.import(file);
                    return { cached: false, skipped: false };
                } else {
                    // Use the cached data since it is up to date and on the same version.
                    this.finish(file, cached.data);
                    return { cached: true, skipped: false };
                }
            });
        }
    }

    /** Import a file directly from disk, skipping the cache. */
    private async import(file: TFile): Promise<void> {
        return this.importer.reload<Partial<PageMetadata>>(file).then(r => {
            this.finish(file, r);
            this.persister.storeFile(file.path, r);
        });
    }

    /** Merge parsed metadata into the in-memory maps without notifying views. */
    private finishQuiet(file: TFile, parsed: Partial<PageMetadata>) {
        let meta = PageMetadata.canonicalize(parsed, link => {
            let realPath = this.metadataCache.getFirstLinkpathDest(link.path, file.path);
            if (realPath) return link.withPath(realPath.path);
            else return link;
        });

        this.pages.set(file.path, meta);
        this.tags.set(file.path, meta.fullTags());
        this.etags.set(file.path, meta.tags);
        this.links.set(file.path, new Set<string>(meta.links.map(l => l.path)));
    }

    /** Finish the reloading of file metadata by adding it to in memory indexes. */
    private finish(file: TFile, parsed: Partial<PageMetadata>) {
        this.finishQuiet(file, parsed);
        this.touch();
        this.trigger("update", file);
        if (this.diskIndexPersistence && this.initialized && !this.suspendDiskSnapshotPersist) {
            this.requestPersistDiskSnapshot?.();
        }
    }
}

/** Indexes files by their full prefix - essentially a simple prefix tree. */
export class PrefixIndex extends Component {
    public static create(vault: Vault, updateRevision: () => void): PrefixIndex {
        return new PrefixIndex(vault, updateRevision);
    }

    constructor(public vault: Vault, public updateRevision: () => void) {
        super();
    }

    private *walk(folder: TFolder, filter?: (path: string) => boolean): Generator<string> {
        for (const file of folder.children) {
            if (file instanceof TFolder) {
                yield* this.walk(file, filter);
            } else if (filter ? filter(file.path) : true) {
                yield file.path;
            }
        }
    }

    /** Get the list of all files under the given path. */
    public get(prefix: string, filter?: (path: string) => boolean): Set<string> {
        let folder = this.vault.getAbstractFileByPath(prefix || "/");
        return new Set(folder instanceof TFolder ? this.walk(folder, filter) : []);
    }

    /** Determines if the given path exists in the prefix index. */
    public pathExists(path: string): boolean {
        return this.vault.getAbstractFileByPath(path || "/") != null;
    }

    /** Determines if the given prefix exists in the prefix index. */
    public nodeExists(prefix: string): boolean {
        return this.vault.getAbstractFileByPath(prefix || "/") instanceof TFolder;
    }

    /**
     * Use the in-memory prefix index to convert a relative path to an absolute one.
     */
    public resolveRelative(path: string, origin?: string): string {
        if (!origin) return path;
        else if (path.startsWith("/")) return path.substring(1);

        let relativePath = getParentFolder(origin) + "/" + path;
        if (this.pathExists(relativePath)) return relativePath;
        else return path;
    }
}

/** Simple path filters which filter file types. */
export namespace PathFilters {
    export function csv(path: string): boolean {
        return path.toLowerCase().endsWith(".csv");
    }

    export function markdown(path: string): boolean {
        let lcPath = path.toLowerCase();
        return lcPath.endsWith(".md") || lcPath.endsWith(".markdown");
    }
}

/**
 * Caches in-use CSVs to make high-frequency reloads (such as actively looking at a document
 * that uses CSV) fast.
 */
export class CsvCache extends Component {
    public static CACHE_EXPIRY_SECONDS: number = 5 * 60;

    // Cache of loaded CSVs; old entries will periodically be removed
    cache: Map<string, { data: DataObject[]; loadTime: DateTime }>;
    // Periodic job which clears out the cache based on time.
    cacheClearInterval: number;

    public constructor(public vault: Vault) {
        super();

        this.cache = new Map();

        // Force-flush the cache on CSV file deletions or modifications.
        this.registerEvent(
            this.vault.on("modify", file => {
                if (file instanceof TFile && PathFilters.csv(file.path)) this.cache.delete(file.path);
            })
        );

        this.registerEvent(
            this.vault.on("delete", file => {
                if (file instanceof TFile && PathFilters.csv(file.path)) this.cache.delete(file.path);
            })
        );
    }

    /** Load a CSV file from the cache, doing a fresh load if it has not been loaded. */
    public async get(path: string): Promise<Result<DataObject[], string>> {
        // Clear old entries on every fresh load, since the path being loaded may be stale.
        this.clearOldEntries();

        let existing = this.cache.get(path);
        if (existing) return Result.success(existing.data);
        else {
            let value = await this.loadInternal(path);
            if (value.successful) this.cache.set(path, { data: value.value, loadTime: DateTime.now() });
            return value;
        }
    }

    /** Do the actual raw loading of a CSV path (which is either local or an HTTP request). */
    private async loadInternal(path: string): Promise<Result<DataObject[], string>> {
        // Allow http://, https://, and file:// prefixes which use AJAX.
        if (path.startsWith("http://") || path.startsWith("https://") || path.startsWith("file://")) {
            try {
                let result = await fetch(path, {
                    method: "GET",
                    mode: "no-cors",
                    redirect: "follow",
                });

                return Result.success(parseCsv(await result.text()));
            } catch (ex) {
                return Result.failure("" + ex + "\n\n" + ex.stack);
            }
        }

        // Otherwise, assume it is a fully-qualified file path.
        try {
            let fileData = await this.vault.adapter.read(path);
            return Result.success(parseCsv(fileData));
        } catch (ex) {
            return Result.failure(`Failed to load data from path '${path}'.`);
        }
    }

    /** Clear old entries in the cache (as measured by insertion time). */
    private clearOldEntries() {
        let currentTime = DateTime.now();
        let keysToRemove = new Set<string>();
        for (let [key, value] of this.cache.entries()) {
            let entryAge = Math.abs(currentTime.diff(value.loadTime, "seconds").seconds);
            if (entryAge > CsvCache.CACHE_EXPIRY_SECONDS) keysToRemove.add(key);
        }

        keysToRemove.forEach(key => this.cache.delete(key));
    }
}

export type StarredEntry =
    | { type: "group"; items: StarredEntry[]; title: string }
    | { type: "file"; path: string; title: string }
    | { type: "folder" }
    | { type: "query" };

/** Optional connector to the Obsidian 'Starred' plugin which allows for efficiently querying if a file is starred or not. */
export class StarredCache extends Component {
    /** Initial delay before checking the cache; we need to wait for it to asynchronously load the initial stars. */
    public static INITIAL_DELAY = 4 * 1_000;
    /** How frequently to check for star updates. */
    public static REFRESH_INTERVAL = 30 * 1_000;

    /** Set of all starred file paths. */
    private stars: Set<string>;

    public constructor(public app: App, public onUpdate: () => void) {
        super();

        this.stars = StarredCache.fetch(this.app);
        this.registerInterval(window.setInterval(() => this.reload(), StarredCache.REFRESH_INTERVAL));

        const initialHandler = window.setTimeout(() => this.reload(), StarredCache.INITIAL_DELAY);
        this.register(() => window.clearTimeout(initialHandler));
    }

    /** Determines if the given path is starred. */
    public starred(path: string): boolean {
        return this.stars.has(path);
    }

    private reload() {
        let newStars = StarredCache.fetch(this.app);
        if (!setsEqual(this.stars, newStars)) {
            this.stars = newStars;
            this.onUpdate();
        }
    }

    /** Fetch all starred files from the stars plugin, if present. */
    private static fetch(app: App): Set<string> {
        let items = (app as any)?.internalPlugins?.plugins?.bookmarks?.instance?.items as StarredEntry[];
        if (items == undefined) return new Set();

        // Retrieve all grouped (nested) items, returning a flat array
        const flattenItems = (items: StarredEntry[]): StarredEntry[] => {
            let children: StarredEntry[] = [];

            return items
                .map(i => {
                    if (i.type == "group" && i.items && i.items.length) {
                        children = [...children, ...i.items];
                    }
                    return i;
                })
                .concat(children.length ? flattenItems(children) : children);
        };

        items = flattenItems(items);

        return new Set(
            items.filter((l): l is { type: "file"; path: string; title: string } => l.type === "file").map(l => l.path)
        );
    }
}

/** A generic index which indexes variables of the form key -> value[], allowing both forward and reverse lookups. */
export class IndexMap {
    /** Maps key -> values for that key. */
    map: Map<string, Set<string>>;
    /** Cached inverse map; maps value -> keys that reference that value. */
    invMap: Map<string, Set<string>>;

    /** Create a new, empty index map. */
    public constructor() {
        this.map = new Map();
        this.invMap = new Map();
    }

    /** Returns all values for the given key. */
    public get(key: string): Set<string> {
        let result = this.map.get(key);
        if (result) {
            return new Set(result);
        } else {
            return new Set();
        }
    }

    /** Returns all keys that reference the given key. Mutating the returned set is not allowed. */
    public getInverse(value: string): Readonly<Set<string>> {
        return this.invMap.get(value) || IndexMap.EMPTY_SET;
    }

    /** Sets the key to the given values; this will delete the old mapping for the key if one was present. */
    public set(key: string, values: Set<string>): this {
        if (!values.size) {
            // no need to store if no values
            this.delete(key);
            return this;
        }
        let oldValues = this.map.get(key);
        if (oldValues) {
            for (let value of oldValues) {
                // Only delete the ones we're not adding back
                if (!values.has(key)) this.invMap.get(value)?.delete(key);
            }
        }
        this.map.set(key, values);
        for (let value of values) {
            if (!this.invMap.has(value)) this.invMap.set(value, new Set([key]));
            else this.invMap.get(value)?.add(key);
        }
        return this;
    }

    /** Clears all values for the given key so they can be re-added. */
    public delete(key: string): boolean {
        let oldValues = this.map.get(key);
        if (!oldValues) return false;

        this.map.delete(key);
        for (let value of oldValues) {
            this.invMap.get(value)?.delete(key);
        }

        return true;
    }

    /** Rename all references to the given key to a new value. */
    public rename(oldKey: string, newKey: string): boolean {
        let oldValues = this.map.get(oldKey);
        if (!oldValues) return false;

        this.delete(oldKey);
        this.set(newKey, oldValues);
        return true;
    }

    /** Clear the entire index. */
    public clear() {
        this.map.clear();
        this.invMap.clear();
    }

    static EMPTY_SET: Readonly<Set<string>> = Object.freeze(new Set<string>());
}

/** Index map wrapper which is case-insensitive in the key. */
export class ValueCaseInsensitiveIndexMap {
    /** Create a new, empty case insensitive index map. */
    public constructor(public delegate: IndexMap = new IndexMap()) {}

    /** Returns all values for the given key. */
    public get(key: string): Set<string> {
        return this.delegate.get(key);
    }

    /** Returns all keys that reference the given value. Mutating the returned set is not allowed. */
    public getInverse(value: string): Readonly<Set<string>> {
        return this.delegate.getInverse(value.toLocaleLowerCase());
    }

    /** Sets the key to the given values; this will delete the old mapping for the key if one was present. */
    public set(key: string, values: Set<string>): this {
        this.delegate.set(key, new Set(Array.from(values).map(v => v.toLocaleLowerCase())));
        return this;
    }

    /** Clears all values for the given key so they can be re-added. */
    public delete(key: string): boolean {
        return this.delegate.delete(key);
    }

    /** Rename all references to the given key to a new value. */
    public rename(oldKey: string, newKey: string): boolean {
        return this.delegate.rename(oldKey, newKey);
    }

    /** Clear the entire index. */
    public clear() {
        this.delegate.clear();
    }
}
