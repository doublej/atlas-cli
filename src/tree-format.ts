// Pure terminal renderers for the CLAUDE.md tree — no API, no I/O.
// Mirrors the shapes returned by atlas-api's /api/claude-tree endpoint.
import { homedir } from 'node:os';

export type NodeKind = 'root' | 'ancestor' | 'project' | 'descendant' | 'glossary';
export interface TreeNode {
	id: string;
	path: string;
	label: string;
	kind: NodeKind;
	parent: string | null;
	preview: { tokens: number; lines: number };
	tokensAccumulated: number;
}
export interface SearchMatch {
	line: number;
	text: string;
	col: number;
}
export interface SearchHit {
	path: string;
	matches: SearchMatch[];
}

const HOME = homedir();
/** Collapse the home dir to `~` for compact display. */
const shortHome = (p: string): string => (p.startsWith(HOME) ? '~' + p.slice(HOME.length) : p);
/** Token count → `2.3k` past a thousand, else the bare number. */
const fmtTokens = (n: number): string => (n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n));
const labelFor = (n: TreeNode): string => `${n.label}  [${n.kind}] ~${fmtTokens(n.preview.tokens)}`;

/** Group nodes by their parent id (null = top-level) for tree walking. */
function childrenByParent(nodes: TreeNode[]): Map<string | null, TreeNode[]> {
	const m = new Map<string | null, TreeNode[]>();
	for (const n of nodes) m.set(n.parent, [...(m.get(n.parent) ?? []), n]);
	return m;
}

/** Render the parent-wired node list as a basic ascii tree (├──/└── connectors). */
export function renderAsciiTree(nodes: TreeNode[]): string {
	if (!nodes.length) return 'No CLAUDE.md found in this tree.';
	const kids = childrenByParent(nodes);
	const out: string[] = [];
	const walk = (node: TreeNode, prefix: string, isLast: boolean): void => {
		out.push(prefix + (isLast ? '└── ' : '├── ') + labelFor(node));
		const next = prefix + (isLast ? '    ' : '│   ');
		const children = kids.get(node.id) ?? [];
		children.forEach((c, i) => walk(c, next, i === children.length - 1));
	};
	for (const root of kids.get(null) ?? []) {
		out.push(labelFor(root));
		const children = kids.get(root.id) ?? [];
		children.forEach((c, i) => walk(c, '', i === children.length - 1));
	}
	return out.join('\n');
}

/** Render search hits as `path` headers with `line:col  text` rows. */
export function formatSearch(hits: SearchHit[]): string {
	if (!hits.length) return 'No matches.';
	const block = (h: SearchHit): string => {
		const rows = h.matches.map((m) => `  ${m.line}:${m.col}  ${m.text.trim()}`).join('\n');
		return `${shortHome(h.path)}\n${rows}`;
	};
	return hits.map(block).join('\n\n');
}

/** Concatenate the ancestor→project chain into one markdown doc — the loaded context. */
export function formatCompose(parts: { node: TreeNode; content: string }[]): string {
	const rule = '─'.repeat(60);
	const total = parts.reduce((s, p) => s + p.node.preview.tokens, 0);
	const header = `<!-- composed context: ${parts.length} files · ~${fmtTokens(total)} tokens -->\n`;
	const blocks = parts.map(
		({ node, content }) =>
			`<!-- ${rule} -->\n<!-- ${shortHome(node.path)}  [${node.kind}] -->\n<!-- ${rule} -->\n\n${content.trimEnd()}\n`
	);
	return [header, ...blocks].join('\n');
}
