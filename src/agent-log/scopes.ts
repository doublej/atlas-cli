/**
 * Agent Log v2 scope primitives: workspace-alias expansion, path normalization,
 * and the deterministic overlap rules that make scopes conflict-detectable.
 * Pure — no I/O (project.ts resolves the boundary, leases.ts applies these rules).
 */
import { existsSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';

/** Primitive scope types. `component:x` is never a primitive — it must be a workspace alias. */
export const SCOPE_TYPES = ['path', 'artifact', 'service', 'host', 'port', 'git'] as const;

export class ScopeError extends Error {}

export type ScopeRef = { type: string; normalized: string };
export type NormalizedScope = ScopeRef & { scope: string };

const segments = (path: string): string[] => path.split('/').filter(Boolean);

/**
 * Deterministic path overlap: `path:a` conflicts with `path:a`, descendants of `a`,
 * and ancestors of `a` (segment-prefix test, both directions). The empty relative
 * path (the whole boundary root) overlaps everything.
 */
export function pathOverlaps(a: string, b: string): boolean {
	const sa = segments(a);
	const sb = segments(b);
	const [short, long] = sa.length <= sb.length ? [sa, sb] : [sb, sa];
	return short.every((segment, index) => segment === long[index]);
}

/** Whether a held lease conflicts with a requested scope under the canonical rules. */
export function conflictsWith(held: ScopeRef, requested: ScopeRef): boolean {
	if (held.type === 'path' || requested.type === 'path')
		return (
			held.type === 'path' &&
			requested.type === 'path' &&
			pathOverlaps(held.normalized, requested.normalized)
		);
	return held.normalized === requested.normalized;
}

/**
 * Expand workspace aliases to primitive scopes before a claim. Unknown names pass
 * through untouched so `normalizeScope` can produce the precise error. Cycle-safe:
 * each name is visited once.
 */
export function expandAliases(scopes: string[], aliases: Record<string, string[]>): string[] {
	const result: string[] = [];
	const visited = new Set<string>();
	const visit = (scope: string): void => {
		if (visited.has(scope)) return;
		visited.add(scope);
		const expansion = aliases[scope];
		if (expansion) expansion.forEach(visit);
		else result.push(scope);
	};
	scopes.forEach(visit);
	return result;
}

/**
 * Boundary-relative canonical path scope. Resolved textually first — claims target
 * planned edits that may not exist yet — then realpath'd when the path is present.
 * Anything outside the project boundary is rejected.
 */
function normalizePath(value: string, root: string): string {
	let abs = value.startsWith('/') ? value : join(root, value);
	if (existsSync(abs)) {
		try {
			abs = realpathSync(abs);
		} catch {
			// broken symlink — keep the textual resolution
		}
	}
	const rel = relative(root, abs);
	if (rel.startsWith('..') || isAbsolute(rel))
		throw new ScopeError(`path scope '${value}' is outside the project boundary (${root})`);
	return rel;
}

/** Parse `type:value` and produce the canonical form used for conflict detection. */
export function normalizeScope(scope: string, root: string): NormalizedScope {
	const colon = scope.indexOf(':');
	if (colon <= 0) throw new ScopeError(`invalid scope '${scope}' (expected type:value)`);
	const type = scope.slice(0, colon);
	const value = scope.slice(colon + 1);
	if (!value) throw new ScopeError(`invalid scope '${scope}' (missing value)`);
	if (type === 'path') return { scope, type, normalized: normalizePath(value, root) };
	if ((SCOPE_TYPES as readonly string[]).includes(type))
		return { scope, type, normalized: scope };
	throw new ScopeError(
		`unknown scope type '${type}' in '${scope}' (use ${SCOPE_TYPES.join(', ')} or a workspace alias)`
	);
}