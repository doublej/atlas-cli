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
/** `up` asks the API for the chain towards the root only — no walk into the children. */
const getTree = (root: string, up = false) =>
	apiGet<TreeNode[]>(`/api/claude-tree?root=${enc(root)}${up ? '&up=1' : ''}`);
const getSearch = (root: string, q: string) =>
	apiGet<SearchHit[]>(`/api/claude-tree?search=${enc(q)}&root=${enc(root)}`);
const getFile = (path: string) => apiGet<{ content: string }>(`/api/claude-tree?path=${enc(path)}`);

/** Open the folder's CLAUDE.md tree in the atlas web viewer. */
async function runWeb(root: string): Promise<void> {
	const url = `${API_BASE}/claude-tree?root=${enc(root)}`;
	if (await ensureUp()) await openUrl(url);
	else console.log(`atlas-api still isn't running (${API_BASE}). Once it's up, open:\n  ${url}`);
}

/** Print the ascii tree of CLAUDE.md context around `root` (`up`: ancestors only). */
async function runView(root: string, up: boolean, json: boolean): Promise<void> {
	await requireUp();
	const nodes = await getTree(root, up);
	console.log(json ? JSON.stringify(nodes) : renderAsciiTree(nodes));
}

/** Search every CLAUDE.md in the tree for `query` (case-insensitive). */
async function runSearch(root: string, query: string | undefined, json: boolean): Promise<void> {
	if (!query) die('usage: atlas tree search <query> [path]');
	await requireUp();
	const hits = await getSearch(root, query);
	console.log(json ? JSON.stringify(hits) : formatSearch(hits));
}

/** Print the ancestor→project chain concatenated — the context loaded at `root`. */
async function runCompose(root: string, json: boolean): Promise<void> {
	await requireUp();
	// The chain is exactly the `up` graph — ask for it and skip the descendant walk.
	const chain = (await getTree(root, true)).filter(
		(n) => n.kind === 'root' || n.kind === 'ancestor' || n.kind === 'project'
	);
	const parts = await Promise.all(
		chain.map(async (node) => ({ node, content: (await getFile(node.path)).content }))
	);
	if (json) return console.log(JSON.stringify(parts.map(({ node, content }) => ({ path: node.path, kind: node.kind, content }))));
	console.log(formatCompose(parts));
}

const HELP = `atlas tree — CLAUDE.md context tree

Usage: atlas tree <command> [path]   (path defaults to the current directory)

Commands:
  view [path] [--up]     print the tree as ascii (--up: ancestors only, no children)
  search <query> [path]  search every CLAUDE.md in the tree (case-insensitive)
  compose [path]         concatenate the ancestor→project chain (the loaded context)
  web [path]             open the tree in the atlas web viewer`;

/** `atlas tree <view|search|compose|web>` — the CLAUDE.md tree, in the terminal or browser. */
export const tree: Command = {
	name: 'tree',
	summary: 'CLAUDE.md tree — view/search/compose in terminal, or `web` for the viewer',
	async run(args) {
		const up = args.includes('--up');
		const json = args.includes('--json');
		const [sub, ...rest] = args.filter((a) => a !== '--up' && a !== '--json');
		if (sub === 'view') return runView(resolveRoot(rest[0]), up, json);
		if (sub === 'search') return runSearch(resolveRoot(rest[1]), rest[0], json);
		if (sub === 'compose') return runCompose(resolveRoot(rest[0]), json);
		if (sub === 'web') return runWeb(resolveRoot(rest[0]));
		console.log(HELP);
	}
};
