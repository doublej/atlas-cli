import type { Command } from '../types';
import { API_BASE, apiGet } from '../api';
import { die, ensureUp, openUrl, requireUp, resolveRoot } from '../util';
import {
	formatCompose,
	formatSearch,
	renderAsciiTree,
	type SearchHit,
	type TreeNode
} from '../tree-format';

const enc = encodeURIComponent;
const getTree = (root: string) => apiGet<TreeNode[]>(`/api/claude-tree?root=${enc(root)}`);
const getSearch = (root: string, q: string) =>
	apiGet<SearchHit[]>(`/api/claude-tree?search=${enc(q)}&root=${enc(root)}`);
const getFile = (path: string) => apiGet<{ content: string }>(`/api/claude-tree?path=${enc(path)}`);

/** Open the folder's CLAUDE.md tree in the atlas web viewer. */
async function runWeb(root: string): Promise<void> {
	const url = `${API_BASE}/claude-tree?root=${enc(root)}`;
	if (await ensureUp()) await openUrl(url);
	else console.log(`atlas-api still isn't running (${API_BASE}). Once it's up, open:\n  ${url}`);
}

/** Print the ascii tree of CLAUDE.md context around `root`. */
async function runView(root: string): Promise<void> {
	await requireUp();
	console.log(renderAsciiTree(await getTree(root)));
}

/** Search every CLAUDE.md in the tree for `query` (case-insensitive). */
async function runSearch(root: string, query?: string): Promise<void> {
	if (!query) die('usage: atlas tree search <query> [path]');
	await requireUp();
	console.log(formatSearch(await getSearch(root, query)));
}

/** Print the ancestor→project chain concatenated — the context loaded at `root`. */
async function runCompose(root: string): Promise<void> {
	await requireUp();
	const chain = (await getTree(root)).filter(
		(n) => n.kind === 'root' || n.kind === 'ancestor' || n.kind === 'project'
	);
	const parts = await Promise.all(
		chain.map(async (node) => ({ node, content: (await getFile(node.path)).content }))
	);
	console.log(formatCompose(parts));
}

const HELP = `atlas tree — CLAUDE.md context tree

Usage: atlas tree <command> [path]   (path defaults to the current directory)

Commands:
  view [path]            print the tree as ascii in the terminal
  search <query> [path]  search every CLAUDE.md in the tree (case-insensitive)
  compose [path]         concatenate the ancestor→project chain (the loaded context)
  web [path]             open the tree in the atlas web viewer`;

/** `atlas tree <view|search|compose|web>` — the CLAUDE.md tree, in the terminal or browser. */
export const tree: Command = {
	name: 'tree',
	summary: 'CLAUDE.md tree — view/search/compose in terminal, or `web` for the viewer',
	async run(args) {
		const [sub, ...rest] = args;
		if (sub === 'view') return runView(resolveRoot(rest[0]));
		if (sub === 'search') return runSearch(resolveRoot(rest[1]), rest[0]);
		if (sub === 'compose') return runCompose(resolveRoot(rest[0]));
		if (sub === 'web') return runWeb(resolveRoot(rest[0]));
		console.log(HELP);
	}
};
