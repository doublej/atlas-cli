import type { Command } from '../types';
import { die } from '../util';

/**
 * `atlas pick` — fuzzy-pick a project via atlas-picker (prints the path).
 * Note: a subprocess can't change the parent shell's directory — use the `pj`
 * shell function for cd-on-select. This is the plain passthrough.
 */
export const pick: Command = {
	name: 'pick',
	summary: 'fuzzy-pick a project via atlas-picker (use the `pj` shell fn to cd)',
	async run(args) {
		const code = await Bun.spawn(['atlas-picker', ...args], {
			stdout: 'inherit',
			stderr: 'inherit'
		}).exited;
		if (code !== 0) die(`atlas-picker exited ${code} (installed? run \`just reinstall\` in atlas-picker)`);
	}
};
