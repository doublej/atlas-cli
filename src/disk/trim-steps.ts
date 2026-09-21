/** What a trim runs: each tool's own clean-up command, plus the opt-in Rust sweep. */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import type { Step } from './trim-run';

const H = homedir();

/** Tools clean themselves — never a whole-cache delete here (spec "Tool trims"). */
export function toolSteps(): Step[] {
	const t = (name: string, needs: string[], cmd: string[], cache?: string): Step => ({ name, op: 'trim', needs, cmd, cache });
	return [
		t('uv cache prune', ['uv'], ['uv', 'cache', 'prune'], join(H, '.cache', 'uv')),
		t('xcrun simctl delete unavailable', ['xcrun'], ['xcrun', 'simctl', 'delete', 'unavailable'], join(H, 'Library', 'Developer', 'CoreSimulator', 'Devices')),
		t('brew cleanup -s', ['brew'], ['brew', 'cleanup', '-s'], join(H, 'Library', 'Caches', 'Homebrew')),
		t('brew autoremove', ['brew'], ['brew', 'autoremove']),
		t('npm cache verify', ['npm', 'node'], ['npm', 'cache', 'verify'], join(H, '.npm', '_cacache')),
		{
			...t('bun cache', ['bun'], []),
			cache: join(H, '.bun', 'install', 'cache'),
			// bun 1.3 has no partial clean-up: `bun pm cache rm` is the only one and it deletes the whole cache.
			skip: 'bun has no clean-up that keeps used entries (`bun pm cache rm` deletes the whole cache)'
		},
		t('cargo cache --autoclean', ['cargo', 'cargo-cache'], ['cargo', 'cache', '--autoclean'], join(H, '.cargo', 'registry'))
	];
}

/** Rust projects with a `target/` under `root`, at most `max`. Dependency, VCS and archive folders are not walked. */
export function rustTargets(root: string, max: number): string[] {
	const prune = ['node_modules', '.git', '.venv', 'venv', '_archive'].flatMap((n, i) => (i ? ['-o', '-name', n] : ['-name', n]));
	const r = Bun.spawnSync(['find', root, '(', ...prune, ')', '-prune', '-o', '-type', 'd', '-name', 'target', '-prune', '-print'], { stderr: 'ignore' });
	return r.stdout
		.toString()
		.split('\n')
		.filter((t) => t && existsSync(join(dirname(t), 'Cargo.toml')))
		.slice(0, max)
		.map(dirname);
}

export function sweepSteps(root: string, days: number, max: number): Step[] {
	return rustTargets(root, max).map((dir) => ({
		name: `cargo sweep ${relative(root, dir)}`,
		op: 'rust-sweep',
		needs: ['cargo', 'cargo-sweep'],
		cmd: ['cargo', 'sweep', '--time', String(days), dir],
		cache: join(dir, 'target')
	}));
}
