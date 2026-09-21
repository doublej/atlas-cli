/**
 * The persisted/`--json` shapes. atlas-disk (the Rust screen) deserializes these, so a
 * rename here is a rename there (`atlas-disk/src/data.rs`).
 */

export type ProjectState = 'active' | 'inactive' | 'eligible';
/** `unknown` = no remote, or the remote couldn't be reached/compared. */
export type PushState = 'pushed' | 'unpushed' | 'unknown' | 'no-git';

export interface ProjectRow {
	/** `<category>/<project>` — the id every command takes. */
	id: string;
	path: string;
	bytes: number;
	/** Days since the newest file that counts as an edit; null = no such file (never eligible). */
	ageDays: number | null;
	/** The file that set the age, relative to the project. */
	ageFile: string | null;
	lastCommit: string | null;
	state: ProjectState;
	dirty: boolean;
	push: PushState;
}

export interface Analysis {
	ranAt: string;
	settings: { devRoot: string; activeDays: number; archiveAgeDays: number; archiveMinMB: number; minMB: number; skipCategories: string[] };
	projects: ProjectRow[];
}

/** Where an archive's bytes are. `na` = the archive location has no cloud. */
export type Storage = 'local' | 'uploading' | 'uploaded' | 'cloud' | 'unknown' | 'na';

export interface ArchiveVersion {
	/** `<category>/<project>@<YYYYMMDD-HHMMSS>` (legacy archives: `@YYYYMMDD`). */
	id: string;
	project: string;
	version: string;
	file: string;
	/** Archive size (logical, whether or not it is downloaded). */
	bytes: number;
	/** Bytes the file occupies on this Mac right now (0 when cloud only). */
	localBytes: number;
	verified: boolean;
	/** Why it isn't verified (no record, changed during archiving, check failed). */
	verifyNote?: string;
	storage: Storage;
	createdAt: string;
}

export type Risk = 'rebuildable' | 'reinstallable' | 'review';

export interface FolderRow {
	path: string;
	bytes: number;
	risk: Risk;
	/** Which rule matched (e.g. "node_modules next to package.json"). */
	why: string;
	/** How to get it back (e.g. "bun install"). */
	restore: string;
	/** Something seems to be using it right now (process name / reason). */
	inUse: string | null;
	/** Re-check fingerprint taken at scan time. */
	newestMtime: number;
	listingHash: string;
	/** Nested inside another listed folder — not counted in the total. */
	nested: boolean;
}

export interface Scan {
	ranAt: string;
	minMB: number;
	/** Deduped: a folder inside another listed folder counts once. */
	totalBytes: number;
	folders: FolderRow[];
}
