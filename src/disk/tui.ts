/** `atlas disk tui` — hands the terminal to the atlas-disk binary (Rust, iocraft). */
import type { Report } from './report';

export async function run(args: string[]): Promise<Report> {
	const bin = Bun.which('atlas-disk');
	if (!bin) throw new Error('atlas-disk is not installed — `cd atlas-disk && just reinstall`');
	const code = await Bun.spawn([bin, ...args], { stdio: ['inherit', 'inherit', 'inherit'] }).exited;
	return { command: 'tui', exit: code === 0 ? 'ok' : 'error' };
}
