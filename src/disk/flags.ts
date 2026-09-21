/** Flag parsing for `atlas disk`: `--name value`, boolean `--name`, `--name=value`, positionals. */
export interface Flags {
	positional: string[];
	has(name: string): boolean;
	get(name: string): string | undefined;
	num(name: string): number | undefined;
	all(name: string): string[];
}

/** `booleans` lists the flags that never take a value. */
export function parseFlags(args: string[], booleans: string[] = []): Flags {
	const values = new Map<string, string[]>();
	const positional: string[] = [];
	const bools = new Set([...booleans, 'json', 'unattended', 'dry-run', 'yes', 'scheduled', 'confirmed']);
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (!a.startsWith('--')) {
			positional.push(a);
			continue;
		}
		const [name, inline] = a.slice(2).split(/=(.*)/s, 2);
		const value = inline ?? (bools.has(name) ? 'true' : args[++i]);
		if (value === undefined) throw new Error(`--${name} needs a value`);
		values.set(name, [...(values.get(name) ?? []), value]);
	}
	return {
		positional,
		has: (n) => values.has(n),
		get: (n) => values.get(n)?.at(-1),
		num: (n) => {
			const v = values.get(n)?.at(-1);
			if (v === undefined) return undefined;
			const x = Number(v);
			if (!Number.isFinite(x)) throw new Error(`--${n} needs a number, got '${v}'`);
			return x;
		},
		all: (n) => values.get(n) ?? []
	};
}
