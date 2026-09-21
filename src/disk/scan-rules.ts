/**
 * What `atlas disk scan` looks for and how it classifies a hit. Ported from
 * `_management/disk/bloat.sh` (pattern names, excluded roots, fat singletons).
 * Anything no rule matches is unclassified: never listed, never offered.
 */
import { existsSync, readdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { Risk } from './types';

export interface Rule {
	risk: Risk;
	why: string;
	restore: string;
}

export const RISK_ORDER: Risk[] = ['rebuildable', 'reinstallable', 'review'];
export const riskMax = (a: Risk, b: Risk): Risk => (RISK_ORDER.indexOf(a) >= RISK_ORDER.indexOf(b) ? a : b);

/** Folder names the walk stops at (prune on match). */
export const PATTERNS = [
	'node_modules', '.venv', 'venv', 'target', '__pycache__',
	'.next', '.svelte-kit', '.nuxt', '.turbo', '.parcel-cache', '.astro',
	'dist', 'build', '.build', 'out', '.gradle', '.pytest_cache', '.mypy_cache', '.ruff_cache', 'DerivedData'
];

/** Never scanned (relative to the scan root): iCloud Drive, cloud storage, device backups, Photos, Music, Movies. */
export const NEVER = [
	'Library/Mobile Documents', 'Library/CloudStorage', 'Library/Application Support/MobileSync',
	'Pictures', 'Music', 'Movies'
];

/**
 * Also pruned from the pattern walk: `Library` and top-level dot folders are tool and app state
 * (an editor extension's node_modules sits next to a package.json and is not ours to delete) —
 * the singletons below cover their caches. `.Trash` is pruned by the same rule.
 */
export const WALK_PRUNE = [...NEVER, 'Library'];

/** Known fat folders at fixed paths, added without walking (bloat.sh phase 2). */
export const SINGLETONS: Record<string, Rule> = {
	'Library/Developer/Xcode/DerivedData': { risk: 'rebuildable', why: 'Xcode build output', restore: 'Xcode rebuilds it on the next build' },
	'Library/Developer/CoreSimulator/Caches': { risk: 'rebuildable', why: 'iOS Simulator caches', restore: 'recreated by the Simulator' },
	'Library/Developer/CoreSimulator/Devices': { risk: 'review', why: 'iOS Simulator devices (apps and their data)', restore: 'recreate devices in Xcode; app data inside is lost' },
	'Library/Caches': { risk: 'review', why: 'all app caches (some apps keep state here)', restore: 'apps refill it; signed-in state or offline data may be lost' },
	'Library/Caches/JetBrains': { risk: 'rebuildable', why: 'JetBrains IDE caches and indexes', restore: 'the IDE re-indexes on next open' },
	'Library/Caches/ms-playwright': { risk: 'reinstallable', why: 'Playwright browsers', restore: 'bunx playwright install' },
	'Library/Caches/Homebrew': { risk: 'reinstallable', why: 'Homebrew download cache', restore: 'brew downloads again when needed' },
	'Library/Containers/com.docker.docker/Data/vms': { risk: 'review', why: 'Docker Desktop disk image (images, volumes)', restore: 'pull images again; volumes inside are lost' },
	'Library/Group Containers/group.com.docker': { risk: 'review', why: 'Docker Desktop data', restore: 'reinstall Docker Desktop; its data is lost' },
	'Library/Group Containers/HUAQ24HBR6.dev.orbstack': { risk: 'review', why: 'OrbStack disk image (containers, volumes)', restore: 'recreate machines and containers; data inside is lost' },
	'Library/Application Support/Code/Cache': { risk: 'rebuildable', why: 'VS Code cache', restore: 'recreated by VS Code' },
	'Library/Application Support/Code/CachedData': { risk: 'rebuildable', why: 'VS Code cached data', restore: 'recreated by VS Code' },
	'Library/pnpm/store': { risk: 'reinstallable', why: 'pnpm package store', restore: 'pnpm install downloads again' },
	'.cache': { risk: 'review', why: 'mixed tool caches (can hold downloaded models)', restore: 'tools refill it; large downloads come back slowly' },
	'.cache/uv': { risk: 'reinstallable', why: 'uv package cache', restore: 'uv downloads again on next sync' },
	'.npm/_cacache': { risk: 'reinstallable', why: 'npm download cache', restore: 'downloads again on next install' },
	'.cargo/registry/cache': { risk: 'reinstallable', why: 'Cargo crate downloads', restore: 'cargo fetches them again' },
	'.cargo/registry/src': { risk: 'reinstallable', why: 'Cargo unpacked crate sources', restore: 'cargo unpacks them again' },
	'.cargo/git': { risk: 'reinstallable', why: 'Cargo git dependencies', restore: 'cargo fetches them again' },
	'.rustup/toolchains': { risk: 'review', why: 'Rust toolchains', restore: 'rustup toolchain install <name>' },
	'.gradle/caches': { risk: 'reinstallable', why: 'Gradle dependency cache', restore: 'Gradle downloads again' },
	'.bun/install/cache': { risk: 'reinstallable', why: 'bun package cache', restore: 'bun install downloads again' },
	'.pyenv/versions': { risk: 'review', why: 'pyenv Python versions', restore: 'pyenv install <version>' },
	'.nvm/versions': { risk: 'review', why: 'nvm Node versions', restore: 'nvm install <version>' }
};

const JS = ['package.json'];
const PY = ['pyproject.toml', 'requirements.txt', 'setup.py', 'uv.lock', 'Pipfile'];
const ANY = [...JS, ...PY, 'Cargo.toml', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle', 'Package.swift', 'go.mod', 'Makefile'];

function jsRestore(has: (f: string) => boolean): string {
	if (has('bun.lock') || has('bun.lockb')) return 'bun install';
	if (has('pnpm-lock.yaml')) return 'pnpm install';
	if (has('yarn.lock')) return 'yarn install';
	if (has('package-lock.json')) return 'npm install';
	return 'bun install';
}

/** Classify a pattern hit by its name and what sits next to it. null = unclassified. */
export function classify(path: string, siblings: Set<string>): Rule | null {
	const name = basename(path);
	const has = (f: string) => siblings.has(f);
	const next = (list: string[]) => list.find(has);
	const build = (m: string | undefined, restore: string): Rule | null =>
		m ? { risk: 'rebuildable', why: `${name} next to ${m}`, restore } : null;
	switch (name) {
		case 'node_modules':
			return has('package.json') ? { risk: 'reinstallable', why: 'node_modules next to package.json', restore: jsRestore(has) } : null;
		case '.venv':
		case 'venv': {
			if (!existsSync(join(path, 'pyvenv.cfg'))) return null;
			const m = next(PY);
			const restore = has('uv.lock') || has('pyproject.toml') ? 'uv sync' : has('requirements.txt') ? 'uv venv && uv pip install -r requirements.txt' : 'recreate the virtualenv';
			return { risk: 'reinstallable', why: `Python virtualenv${m ? ` next to ${m}` : ''}`, restore };
		}
		case 'target':
			return has('Cargo.toml') ? build('Cargo.toml', 'cargo build') : build(next(['pom.xml']), 'mvn package');
		case '__pycache__':
			return { risk: 'rebuildable', why: 'Python bytecode cache', restore: 'Python recreates it on import' };
		case '.pytest_cache':
		case '.mypy_cache':
		case '.ruff_cache':
			return { risk: 'rebuildable', why: `${name} tool cache`, restore: 'recreated on the next run' };
		case '.next':
		case '.svelte-kit':
		case '.nuxt':
		case '.turbo':
		case '.parcel-cache':
		case '.astro':
			return build(next(JS), 'recreated by the next dev/build run');
		case '.gradle':
			return build(next(['build.gradle', 'build.gradle.kts', 'settings.gradle']), 'recreated by the next Gradle build');
		case '.build':
			return build(next(['Package.swift']), 'swift build');
		case 'dist':
		case 'build':
		case 'out':
			return build(next(ANY), 'recreated by the project build');
		case 'DerivedData':
			return { risk: 'rebuildable', why: 'Xcode build output', restore: 'Xcode rebuilds it on the next build' };
	}
	return null;
}

const listings = new Map<string, Set<string>>();
/** The names next to `path` (cached per parent: many hits share one). */
export function siblingsOf(path: string): Set<string> {
	const dir = dirname(path);
	let s = listings.get(dir);
	if (!s) {
		try {
			s = new Set(readdirSync(dir));
		} catch {
			s = new Set();
		}
		listings.set(dir, s);
	}
	return s;
}

/** Singletons whose files an app uses while it runs: path (relative to root) → process names (`ps -c`). */
export const USERS: Record<string, string[]> = {
	'Library/Developer/CoreSimulator/Devices': ['Simulator', 'launchd_sim'],
	'Library/Developer/Xcode/DerivedData': ['Xcode', 'xcodebuild'],
	'Library/Containers/com.docker.docker/Data/vms': ['com.docker.backend', 'Docker Desktop'],
	'Library/Group Containers/group.com.docker': ['com.docker.backend', 'Docker Desktop'],
	'Library/Group Containers/HUAQ24HBR6.dev.orbstack': ['OrbStack', 'OrbStack Helper'],
	'.rustup/toolchains': ['cargo', 'rustc', 'rust-analyzer']
};
