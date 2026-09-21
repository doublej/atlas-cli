/** The interactive half of `atlas disk clean`: pick folders, look inside each, see the plan. */
import { readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { human } from './fsutil';
import { measure } from './scan-measure';
import type { FolderRow } from './types';

const short = (p: string) => p.replace(homedir(), '~');
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export async function pickFolders(rows: FolderRow[]): Promise<FolderRow[]> {
	const { checkbox } = await import('@inquirer/prompts'); // lazy: see approval.ts confirm()
	return checkbox({
		message: 'Folders to delete (space marks · a select/deselect all · i invert · enter continues)',
		pageSize: 20,
		loop: false,
		choices: rows.map((r) => ({
			value: r,
			name: `${human(r.bytes).padStart(9)}  ${r.risk.padEnd(13)} ${short(r.path)}${r.nested ? ' [nested]' : ''}${r.inUse ? ` [in use: ${r.inUse}]` : ''}`,
			description: `${r.why} · restore: ${r.restore}`
		}))
	});
}

/** A folder's top-level contents and its newest files. */
export async function preview(r: FolderRow): Promise<string> {
	let names: string[] = [];
	try {
		names = readdirSync(r.path, { withFileTypes: true }).map((d) => (d.isDirectory() ? `${d.name}/` : d.name));
	} catch {
		names = ['(unreadable)'];
	}
	const m = await measure(r.path, 5);
	const shown = names.slice(0, 20).join('  ') + (names.length > 20 ? `  … +${names.length - 20} more` : '');
	const newest = m.newest.map((f) => `    ${day(f.mtime)}  ${f.path.slice(r.path.length + 1)}`);
	return [
		`${short(r.path)} — ${human(r.bytes)}, ${r.risk}${r.inUse ? `, IN USE: ${r.inUse}` : ''}`,
		`  ${r.why} · restore: ${r.restore}`,
		`  contains (${names.length}): ${shown}`,
		'  newest files:',
		...newest
	].join('\n');
}

/** The count, deduped total and paths, with where each one goes. */
export function planText(rows: FolderRow[], toTrash: (r: FolderRow) => boolean): string {
	const total = rows.reduce((s, r) => s + r.bytes, 0);
	const lines = rows.map((r) => `  ${human(r.bytes).padStart(9)}  ${toTrash(r) ? 'Trash ' : 'delete'}  ${short(r.path)}${r.inUse ? `  ⚠ in use: ${r.inUse}` : ''}`);
	return [`${rows.length} folder(s), ${human(total)}:`, ...lines].join('\n');
}
