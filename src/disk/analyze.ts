/** `atlas disk analyze [--min-size MB] [--cached] [--json]` — every `<category>/<project>`: size, age, state, git. */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseFlags } from './flags';
import { loadSettings, statePath, type Settings } from './settings';
import { ago, human, writeJsonAtomic } from './fsutil';
import { mapLimit } from './archive-exec';
import { duBytesAsync, measureProject } from './analyze-project';
import type { Analysis, ProjectRow } from './types';
import type { Report } from './report';

/** Project-level folder names that are never projects (analyze.sh). */
const NOT_PROJECTS = new Set(['node_modules', '__pycache__', 'venv', 'target']);

const subdirs = (dir: string): string[] =>
	readdirSync(dir, { withFileTypes: true })
		.filter((d) => d.isDirectory() && !d.name.startsWith('.'))
		.map((d) => d.name);

/** `<category>/<project>` ids under devRoot, skipped categories left out. */
export function listProjects(s: Settings): string[] {
	return subdirs(s.devRoot)
		.filter((c) => !s.skipCategories.includes(c))
		.flatMap((c) => subdirs(join(s.devRoot, c)).filter((p) => !NOT_PROJECTS.has(p)).map((p) => `${c}/${p}`));
}

export async function analyze(s: Settings, minMB: number): Promise<Analysis> {
	const ids = listProjects(s);
	const sizes = await mapLimit(ids, 16, (id) => duBytesAsync(join(s.devRoot, id)));
	const keep = ids.map((id, i) => [id, sizes[i]] as const).filter(([, b]) => b >= minMB * 1024 * 1024);
	const projects = await mapLimit(keep, 16, ([id, b]) => measureProject(id, join(s.devRoot, id), s, b));
	projects.sort((a, b) => b.bytes - a.bytes);
	const { devRoot, activeDays, archiveAgeDays, archiveMinMB, skipCategories } = s;
	const analysis = { ranAt: new Date().toISOString(), settings: { devRoot, activeDays, archiveAgeDays, archiveMinMB, minMB, skipCategories }, projects };
	writeJsonAtomic(statePath('analysis.json'), analysis);
	return analysis;
}

export function loadAnalysis(): Analysis | null {
	const file = statePath('analysis.json');
	return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Analysis) : null;
}

function row(p: ProjectRow): string {
	const age = p.ageDays === null ? '   -' : `${String(p.ageDays).padStart(4)}d`;
	const flags = [p.dirty ? 'dirty' : '', p.push === 'unpushed' ? 'unpushed' : p.push === 'unknown' ? 'push?' : ''].filter(Boolean).join(',');
	const why = `${p.ageFile ?? 'no edit files'}${p.lastCommit ? ` · commit ${p.lastCommit.slice(0, 10)}` : ''}`;
	return `${human(p.bytes).padStart(9)}  ${p.state.padEnd(8)} ${age}  ${p.id.padEnd(40)} ${flags.padEnd(15)} ${why}`;
}

export function renderAnalysis(a: Analysis): string {
	const eligible = a.projects.filter((p) => p.state === 'eligible');
	const total = eligible.reduce((n, p) => n + p.bytes, 0);
	return [
		`${'SIZE'.padStart(9)}  ${'STATE'.padEnd(8)}  AGE  ${'PROJECT'.padEnd(40)} ${'FLAGS'.padEnd(15)} AGE SET BY · LAST COMMIT`,
		...a.projects.map(row),
		'',
		`${a.projects.length} projects · ${eligible.length} archive-eligible (${human(total)}) · analysis ran ${ago(a.ranAt)}`
	].join('\n');
}

export async function run(args: string[]): Promise<Report> {
	const f = parseFlags(args, ['cached']);
	const s = loadSettings();
	let a: Analysis | null;
	if (f.has('cached')) {
		a = loadAnalysis();
		if (!a) return { command: 'analyze', exit: 'nothing', text: 'No saved analysis — run `atlas disk analyze`.' };
		// An archived (or moved) project leaves the saved analysis until the next run; drop it now.
		a = { ...a, projects: a.projects.filter((p) => existsSync(p.path)) };
		const min = f.num('min-size');
		if (min !== undefined) a = { ...a, projects: a.projects.filter((p) => p.bytes >= min * 1024 * 1024) };
	} else a = await analyze(s, f.num('min-size') ?? 0);
	return { command: 'analyze', exit: a.projects.length ? 'ok' : 'nothing', data: a, text: renderAnalysis(a) };
}
