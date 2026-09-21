/** `atlas disk config [get [key] | set <key> <value> | reset <key>]` — thresholds, rules, locations. */
import { DEFAULTS, loadSettings, saveSettings, type Settings } from './settings';
import { parseFlags } from './flags';
import type { Report } from './report';

/** Coerce a CLI string to the type of the default: number, boolean, list, null, or string. */
function coerce(key: keyof Settings, raw: string): unknown {
	const def = DEFAULTS[key];
	if (raw === 'null' || raw === 'off') {
		if (key === 'keepNewest') return null;
		throw new Error(`${key} can't be null`);
	}
	if (key === 'keepNewest' || typeof def === 'number') {
		const n = Number(raw);
		if (!Number.isFinite(n) || n < 0) throw new Error(`${key} needs a non-negative number`);
		if (key === 'keepNewest' && n < 1) throw new Error('keepNewest must be ≥ 1 (the only version is never removed)');
		return n;
	}
	if (typeof def === 'boolean') {
		if (!['true', 'false'].includes(raw)) throw new Error(`${key} needs true or false`);
		return raw === 'true';
	}
	if (Array.isArray(def)) return raw.split(',').map((s) => s.trim()).filter(Boolean);
	if (key === 'theme' && !['auto', 'dark', 'light'].includes(raw)) throw new Error('theme is auto, dark or light');
	if (key === 'schedules') throw new Error('use `atlas disk schedule` for schedules');
	return raw;
}

export async function run(args: string[]): Promise<Report> {
	const f = parseFlags(args);
	const [verb = 'get', key, value] = f.positional;
	const s = loadSettings();
	if (verb === 'get') {
		const data = key ? { [key]: s[key as keyof Settings] } : s;
		const text = Object.entries(data).map(([k, v]) => `${k.padEnd(22)} ${JSON.stringify(v)}`).join('\n');
		return { command: 'config', exit: 'ok', data, text };
	}
	if (!key || !(key in DEFAULTS)) throw new Error(`unknown key '${key ?? ''}' — keys: ${Object.keys(DEFAULTS).join(', ')}`);
	const k = key as keyof Settings;
	if (verb === 'set') {
		if (value === undefined) throw new Error(`usage: atlas disk config set ${k} <value>`);
		(s as unknown as Record<string, unknown>)[k] = coerce(k, value);
	} else if (verb === 'reset') {
		(s as unknown as Record<string, unknown>)[k] = structuredClone(DEFAULTS[k]);
	} else throw new Error(`unknown verb '${verb}' (get | set | reset)`);
	saveSettings(s);
	return { command: 'config', exit: 'ok', data: { [k]: s[k] }, text: `${k} = ${JSON.stringify(s[k])}` };
}
