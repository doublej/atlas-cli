/** Argument parsing for `atlas agent-log`. Ported from framelink's tools/agent-log. */
export type Options = Map<string, string[]>;

/**
 * Canonical operations. `begin` takes a fixed verb so entries stay groupable; anything
 * specific about the work belongs in the summary, not in an invented operation name.
 */
export const OPERATIONS = [
	'build',
	'commit',
	'deploy',
	'edit',
	'implement',
	'investigate',
	'merge',
	'push',
	'review',
	'sync',
	'test'
] as const;

export const USAGE = `usage:
  atlas agent-log recent [--since 30m] [--scope SCOPE] [--json]
  atlas agent-log begin OPERATION --scope SCOPE [--bead ID] [--ttl 20m] -- SUMMARY
    OPERATION: ${OPERATIONS.join(' | ')}
  atlas agent-log finding --scope SCOPE --evidence TEXT [--bead ID] [--ttl 4h] -- SUMMARY
  atlas agent-log end OP_ID [--outcome ok|failed|cancelled] -- SUMMARY
  atlas agent-log handoff [--scope SCOPE] [--bead ID] -- SUMMARY
  atlas agent-log run build|deploy|test --scope SCOPE [--bead ID] [--ttl 20m] -- COMMAND...
  atlas agent-log status [--json] [--session ID]
  atlas agent-log claim SCOPE... [--ttl 20m] [--session ID] [--task ID] -- WHY
  atlas agent-log release [SCOPE...] [--session ID]
  atlas agent-log doctor
  atlas agent-log init
  atlas agent-log console`;

export function die(message: string): never {
	console.error(`agent-log: ${message}`);
	process.exit(2);
}

export function parseDuration(value: string): number {
	const match = /^(\d+)(s|m|h)$/.exec(value);
	if (!match) die(`invalid duration '${value}' (use 30s, 20m, or 4h)`);
	const unit = { s: 1_000, m: 60_000, h: 3_600_000 }[match[2] as 's' | 'm' | 'h'];
	return Number(match[1]) * unit;
}

function parseOptions(args: string[]): { options: Options; positional: string[] } {
	const options: Options = new Map();
	const positional: string[] = [];
	for (let index = 0; index < args.length; index += 1) {
		const name = args[index];
		if (!name.startsWith('--')) {
			positional.push(name);
			continue;
		}
		const value = args[index + 1];
		if (!value || value.startsWith('--')) die(`${name} needs a value`);
		options.set(name, [...(options.get(name) ?? []), value]);
		index += 1;
	}
	return { options, positional };
}

export function splitArgs(args: string[]) {
	const divider = args.indexOf('--');
	const before = divider === -1 ? args : args.slice(0, divider);
	return { ...parseOptions(before), trailing: divider === -1 ? [] : args.slice(divider + 1) };
}

export function validateSummary(summary: string): void {
	if (!summary) die(`a summary is required\n${USAGE}`);
	if (summary.length > 240) die('summary must be 240 characters or fewer');
}

export function requireOperation(operation: string): string {
	if (!operation) die(`begin needs an operation\n${USAGE}`);
	if (!(OPERATIONS as readonly string[]).includes(operation))
		die(
			`unknown operation '${operation}'\nuse one of: ${OPERATIONS.join(', ')}\n` +
				"put what makes this run specific in the summary after '--', not in the operation"
		);
	return operation;
}

export function requireScopes(options: Options): string[] {
	const scopes = options.get('--scope') ?? [];
	if (scopes.length === 0) die('at least one --scope is required');
	return scopes;
}
