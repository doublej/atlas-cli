import { mkdir, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import type { Command } from '../types';
import { apiGet, apiPost, isUp } from '../api';
import { bootstrapJournal } from '../agent-log/init';
import { bootstrapFlow } from './flow';
import { getCategoryTemplates } from '../../../shared/templates';
import { DEV_FOLDER, discoverTemplates, templatesDir, type Template } from '../template-discovery';
import type { Category } from '../new-prompts';
import { cdLine, die, shellExec } from '../util';

const NEW_USAGE = `atlas new — scaffold a project from a cookiecutter template

Usage: atlas new                              interactive pickers
       atlas new <family/name> --name <name>  non-interactive (cookiecutter --no-input)

Options:
  --name      project_name for cookiecutter (slug auto-derives)
  --category  dev category folder → creates in ${DEV_FOLDER}/<category>
  --out       explicit output dir (overrides --category)
  --var k=v   extra cookiecutter context, repeatable (e.g. --var include_tracking=y)
`;

async function loadCategories(online: boolean): Promise<Category[] | null> {
	if (!online) return null;
	try {
		return (await apiGet<{ categories: Category[] }>('/api/categories')).categories;
	} catch (e) {
		// API is reachable but the route failed (e.g. a stale daemon missing the new route).
		// Surface it so the free-text fallback isn't mistaken for the picker being broken.
		console.warn(`⚠ /api/categories failed (${(e as Error).message}).`);
		console.warn('  Restart atlas-api to pick up new routes: launchctl kickstart -k gui/$(id -u)/com.jurrejan.atlas-api');
		return null;
	}
}

async function loadTemplates(online: boolean): Promise<Template[]> {
	if (online) {
		try {
			const { templates } = await apiGet<{ templates: Template[] }>('/api/templates');
			if (templates.length) return templates;
		} catch {
			/* fall through to local discovery */
		}
	}
	return discoverTemplates(templatesDir());
}

/** Best-effort rescan so the new project shows up in atlas immediately. */
async function refresh(): Promise<void> {
	try {
		await apiPost('/api/refresh');
	} catch {
		/* the project is on disk regardless — next scan picks it up */
	}
}

/** The subdir cookiecutter just created: newest child of target modified after start. */
async function findCreatedDir(target: string, startedAtMs: number): Promise<string | null> {
	try {
		const entries = await readdir(target, { withFileTypes: true });
		let best: { path: string; mtimeMs: number } | null = null;
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			const full = join(target, entry.name);
			const stats = await stat(full);
			if (stats.mtimeMs >= startedAtMs && (!best || stats.mtimeMs > best.mtimeMs)) {
				best = { path: full, mtimeMs: stats.mtimeMs };
			}
		}
		return best?.path ?? null;
	} catch {
		return null;
	}
}

/** Land the user in the new project — the `atlas` zsh wrapper evals the cd (see `shellExec`). */
const handOff = (created: string): Promise<void> => shellExec(cdLine(created));

/** Post-scaffold tail shared by both flows: journal bootstrap + atlas rescan + cd hand-off. */
async function finish(target: string, startedAtMs: number, code: number): Promise<void> {
	if (code !== 0) {
		process.exitCode = code;
		return;
	}
	const created = await findCreatedDir(target, startedAtMs);
	// Git first: template post-gen hooks run `atlas agent-log init` before the repo exists,
	// so the journal db is only warmed here. bootstrapJournal is idempotent.
	if (created) {
		await bootstrapFlow(created);
		try {
			bootstrapJournal(created);
		} catch {
			/* the journal is a nicety — scaffolding already succeeded */
		}
	}
	await refresh();
	if (created) await handOff(created);
}

/**
 * If the template declares a `port` var, allocate one from atlas-api so scaffolded
 * projects don't collide. `null` means "let the template's own default apply" — offline,
 * unreachable, or no such var. Extra context keys work with or without `--no-input`:
 * without it they just pre-fill cookiecutter's interactive prompt default.
 */
async function resolvePortArg(templatePath: string, online: boolean): Promise<string | null> {
	let hasPortVar = false;
	try {
		const cc = (await Bun.file(join(templatePath, 'cookiecutter.json')).json()) as Record<string, unknown>;
		hasPortVar = 'port' in cc;
	} catch {
		/* no readable cookiecutter.json — treat as no port var */
	}
	if (!hasPortVar) return null;

	if (!online) {
		console.log('  offline — used template default port');
		return null;
	}

	try {
		const { port } = await apiGet<{ port: number }>('/api/ports/allocate');
		return `port=${port}`;
	} catch (e) {
		console.warn(`⚠ /api/ports/allocate failed (${(e as Error).message}) — used template default port`);
		return null;
	}
}

async function scaffold(template: Template, target: string, context: string[] = [], noInput = false): Promise<number> {
	await mkdir(target, { recursive: true });
	const ccArgs = [...(noInput ? ['--no-input'] : []), template.path, ...context];
	return Bun.spawn(['cookiecutter', ...ccArgs, '-o', target], {
		stdin: 'inherit',
		stdout: 'inherit',
		stderr: 'inherit'
	}).exited;
}

interface DirectArgs {
	template: string;
	name?: string;
	category?: string;
	out?: string;
	vars: string[];
}

/** Parse `atlas new` args: 'help', a non-interactive spec, or null → interactive flow. */
function parseNewArgs(args: string[]): DirectArgs | 'help' | null {
	const { values, positionals } = parseArgs({
		args,
		options: {
			name: { type: 'string' },
			category: { type: 'string' },
			out: { type: 'string' },
			var: { type: 'string', multiple: true },
			help: { type: 'boolean', short: 'h' }
		},
		allowPositionals: true
	});
	if (values.help) return 'help';
	if (!positionals.length) return null;
	const [template] = positionals;
	return { template, name: values.name, category: values.category, out: values.out, vars: values.var ?? [] };
}

/** Non-interactive scaffold: `atlas new typescript/sveltekit --name "My App" --category web`. */
async function scaffoldDirect(a: DirectArgs): Promise<void> {
	if (!a.name) die(`Need --name <project name>.\n\n${NEW_USAGE}`);
	if (!a.out && !a.category) die(`Need --category <folder> or --out <dir>.\n\n${NEW_USAGE}`);
	const online = await isUp();
	const templates = await loadTemplates(online);
	const template = templates.find((t) => `${t.family}/${t.name}` === a.template);
	if (!template) die(`Unknown template '${a.template}' — run \`atlas new\` to browse.`);
	const target = a.out ?? join(DEV_FOLDER, a.category as string);
	const userSetPort = a.vars.some((v) => v.startsWith('port='));
	const portArg = userSetPort ? null : await resolvePortArg(template.path, online);
	const context = [`project_name=${a.name}`, ...a.vars, ...(portArg ? [portArg] : [])];
	const startedAt = Date.now();
	const code = await scaffold(template, target, context, true);
	await finish(target, startedAt, code);
}

async function scaffoldFlow(): Promise<void> {
	// Lazy: importing @inquirer/prompts at load time cuts every command's piped stdout off at 64 KB.
	const { pickCategory, pickOutputDir, pickTemplate } = await import('../new-prompts');
	const online = await isUp();
	const category = await pickCategory(await loadCategories(online));
	const templates = await loadTemplates(online);
	if (!templates.length) return void console.error(`No templates found in ${templatesDir()}`);
	const template = await pickTemplate(templates, getCategoryTemplates(category));
	const target = await pickOutputDir(join(DEV_FOLDER, category));
	const portArg = await resolvePortArg(template.path, online);
	const startedAt = Date.now();
	const code = await scaffold(template, target, portArg ? [portArg] : [], false);
	await finish(target, startedAt, code);
}

/** `atlas new` — pick a category + template, run cookiecutter, register at birth. */
export const newProject: Command = {
	name: 'new',
	summary: 'scaffold a new project from a cookiecutter template',
	usage: NEW_USAGE,
	async run(args) {
		const parsed = parseNewArgs(args);
		if (parsed === 'help') return void console.log(NEW_USAGE);
		if (!parsed && !process.stdin.isTTY)
			die(`atlas new needs a terminal for its pickers. Without one:\n  atlas new <family/name> --name <name> --category <cat>   (templates: atlas templates)`);
		try {
			if (parsed) await scaffoldDirect(parsed);
			else await scaffoldFlow();
		} catch (e) {
			if (e instanceof Error && e.name === 'ExitPromptError') return; // user cancelled (Ctrl-C)
			throw e;
		}
	}
};
