import { PageMetadata } from "data-model/markdown";
import { Transferable } from "data-model/transferable";

/** Current on-disk index snapshot format revision (bump when JSON shape changes). */
export const DISK_SNAPSHOT_FORMAT = 1;

/** Key used inside plugin `data.json` for the optional index snapshot (alongside settings). */
export const PLUGIN_DATA_INDEX_SNAPSHOT_KEY = "diskIndexSnapshot";

export interface DiskSnapshotFileV1 {
    format: number;
    dataviewVersion: string;
    savedAt: number;
    files: Record<string, { mtime: number; data: unknown }>;
}

/** Plain object suitable for `Transferable.transferable` from an in-memory page. */
export function pageMetadataToPartial(meta: PageMetadata): Partial<PageMetadata> {
    return {
        path: meta.path,
        ctime: meta.ctime,
        mtime: meta.mtime,
        size: meta.size,
        day: meta.day,
        title: meta.title,
        fields: meta.fields,
        tags: meta.tags,
        aliases: meta.aliases,
        links: meta.links,
        lists: meta.lists,
        frontmatter: meta.frontmatter,
    };
}

export function buildDiskSnapshotObject(dataviewVersion: string, pages: Map<string, PageMetadata>): DiskSnapshotFileV1 {
    const files: Record<string, { mtime: number; data: unknown }> = {};
    for (const [path, meta] of pages) {
        files[path] = {
            mtime: meta.mtime.toMillis(),
            data: Transferable.transferable(pageMetadataToPartial(meta)),
        };
    }
    return {
        format: DISK_SNAPSHOT_FORMAT,
        dataviewVersion,
        savedAt: Date.now(),
        files,
    };
}

export function buildDiskSnapshotJson(dataviewVersion: string, pages: Map<string, PageMetadata>): string {
    return JSON.stringify(buildDiskSnapshotObject(dataviewVersion, pages));
}

/** Validate a snapshot loaded from plugin `data.json`. */
export function parseDiskSnapshotObject(raw: unknown): DiskSnapshotFileV1 | null {
    if (!raw || typeof raw !== "object") return null;
    const snap = raw as DiskSnapshotFileV1;
    if (snap.format !== DISK_SNAPSHOT_FORMAT) return null;
    if (typeof snap.dataviewVersion !== "string" || !snap.files || typeof snap.files !== "object") return null;
    return snap;
}

export function parseDiskSnapshotJson(raw: string): DiskSnapshotFileV1 | null {
    try {
        return parseDiskSnapshotObject(JSON.parse(raw));
    } catch {
        return null;
    }
}

/** Rehydrate transferable snapshot data into a partial `PageMetadata` input. */
export function snapshotDataToPartial(data: unknown): Partial<PageMetadata> {
    return Transferable.value(data) as Partial<PageMetadata>;
}
