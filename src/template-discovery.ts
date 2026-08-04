import { Glob } from 'bun';
import { homedir } from 'node:os';
import { dirname, join, relative } from 'node:path';

/** The development monorepo root — where category folders live. */
export const DEV_FOLDER = join(homedir(), 'Documents', 'development');

/** Where cookiecutter templates live; mirrors atlas-api's `ATLAS_TEMPLATES_DIR` default. */
export const templatesDir = (): string =>
	process.env.ATLAS_TEMPLATES_DIR ?? join(DEV_FOLDER, '_management', 'cookiecutter-templates');

/** Matches `/api/templates`'s shape so online and offline paths are interchangeable. */
export interface Template {
	family: string;
	name: string;
	description: string;
	version: string | null;
	path: string;
}

async function parseTemplate(ccPath: string, root: string): Promise<Template | null> {
	try {
		const content = (await Bun.file(ccPath).json()) as Record<string, unknown>;
		const dir = dirname(ccPath);
		const parts = relative(root, dir).split('/');
		return {
			family: parts.length > 1 ? parts[0] : 'root',
			name: parts[parts.length - 1],
			description:
				(content.description as string) || (content.project_description as string) || 'No description',
			version: (content._version as string) ?? null,
			path: dir
		};
	} catch {
		return null;
	}
}

/** Offline fallback: glob `cookiecutter.json` under `root` directly (no API needed). */
export async function discoverTemplates(root: string): Promise<Template[]> {
	const glob = new Glob('**/cookiecutter.json');
	const out: Template[] = [];
	for await (const file of glob.scan({ cwd: root, absolute: true })) {
		const t = await parseTemplate(file, root);
		if (t) out.push(t);
	}
	return out.sort((a, b) => a.family.localeCompare(b.family) || a.name.localeCompare(b.name));
}
