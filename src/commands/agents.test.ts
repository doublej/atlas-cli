import { expect, test } from 'bun:test';
import { agentRows } from './agents';

test('agentRows flattens projects, MCP first, then by name', () => {
	const p = (relativePath: string, agentInterfaces?: { kind: 'cli' | 'mcp'; name: string }[]) =>
		({ name: relativePath, slug: relativePath, path: `/d/${relativePath}`, relativePath, host: 'm2', agentInterfaces });
	const rows = agentRows([p('a', [{ kind: 'cli', name: 'zed' }, { kind: 'mcp', name: 'a-mcp' }]), p('b'), p('c', [{ kind: 'cli', name: 'bee' }])]);
	expect(rows.map((r) => `${r.kind}:${r.name}:${r.project}`)).toEqual(['mcp:a-mcp:a', 'cli:bee:c', 'cli:zed:a']);
});
