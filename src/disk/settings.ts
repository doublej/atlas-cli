/** Where `atlas disk` keeps its state, and the user's thresholds. One JSON file, defaults filled in. */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { writeJsonAtomic } from './fsutil';

/**
 * `ATLAS_DISK_HOME` moves everything (tests, a second profile). Read on every call: bun test
 * shares one module cache across test files, and each file points it at its own scratch dir.
 */
export const stateDir = (): string =>
	process.env.ATLAS_DISK_HOME ?? join(homedir(), 'Library', 'Application Support', 'atlas-disk');
export const statePath = (name: string): string => join(stateDir(), name);

export interface Schedule {
	enabled: boolean;
	/** 0 = Sunday … 6 = Saturday (launchd's Weekday). */
	weekday: number;
	hour: number;
	minute: number;
}

export interface Settings {
	devRoot: string;
	activeDays: number;
	archiveAgeDays: number;
	archiveMinMB: number;
	skipCategories: string[];
	archiveDir: string;
	/** zstd level; 0 = no compression. "fast" = 1, "strong" = 19. */
	compression: number;
	/** Automatic removal of old archive versions: keep this many per project. null = off. */
	keepNewest: number | null;
	scanMinMB: number;
	/** Standing rule: rebuildable-level cleanup without confirmation (unattended). */
	autoCleanRebuildable: boolean;
	rustSweep: boolean;
	rustSweepDays: number;
	rustSweepMax: number;
	stepTimeoutSec: number;
	notifyTotalGB: number;
	notifyGrowthGB: number;
	schedules: { scan: Schedule; trim: Schedule };
	theme: 'auto' | 'dark' | 'light';
}

export const DEFAULTS: Settings = {
	devRoot: join(homedir(), 'dev'),
	activeDays: 30,
	archiveAgeDays: 180,
	archiveMinMB: 100,
	skipCategories: ['_archive', '_life', '_management', '_sandbox', '_data'],
	archiveDir: join(homedir(), 'Library', 'Mobile Documents', 'com~apple~CloudDocs', 'Dev Archive'),
	compression: 1,
	keepNewest: null,
	scanMinMB: 100,
	autoCleanRebuildable: false,
	rustSweep: false,
	rustSweepDays: 30,
	rustSweepMax: 50,
	stepTimeoutSec: 180,
	notifyTotalGB: 50,
	notifyGrowthGB: 10,
	schedules: {
		scan: { enabled: false, weekday: 0, hour: 10, minute: 0 },
		trim: { enabled: false, weekday: 0, hour: 11, minute: 0 }
	},
	theme: 'auto'
};

export function ensureStateDir(): void {
	mkdirSync(stateDir(), { recursive: true });
}

export function loadSettings(): Settings {
	const file = statePath('settings.json');
	if (!existsSync(file)) return structuredClone(DEFAULTS);
	const saved = JSON.parse(readFileSync(file, 'utf8')) as Partial<Settings>;
	return { ...structuredClone(DEFAULTS), ...saved, schedules: { ...structuredClone(DEFAULTS.schedules), ...saved.schedules } };
}

export function saveSettings(settings: Settings): void {
	ensureStateDir();
	writeJsonAtomic(statePath('settings.json'), settings);
}
