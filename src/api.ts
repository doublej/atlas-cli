// Thin client to the project-atlas API. Override the host with ATLAS_API.
export const API_BASE = process.env.ATLAS_API ?? 'http://localhost:47891';

/**
 * Is atlas-api reachable right now? (2s timeout, never throws.)
 *
 * Hits `/api/health`, not `/` — the answer must mean "the process is serving", not
 * "the UI renders". Health-checking the root page made every consumer restart the
 * daemon whenever a Svelte route threw a 500, or whenever rendering took >1s.
 */
export async function isUp(): Promise<boolean> {
	try {
		const r = await fetch(`${API_BASE}/api/health`, { signal: AbortSignal.timeout(2000) });
		return r.ok;
	} catch {
		return false;
	}
}

export async function apiGet<T>(path: string): Promise<T> {
	const r = await fetch(`${API_BASE}${path}`);
	if (!r.ok) throw new Error(`GET ${path} → ${r.status} ${r.statusText}`);
	return r.json() as Promise<T>;
}

export async function apiPost<T>(path: string, body?: unknown): Promise<T> {
	const r = await fetch(`${API_BASE}${path}`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: body === undefined ? undefined : JSON.stringify(body)
	});
	if (!r.ok) throw new Error(`POST ${path} → ${r.status} ${r.statusText}`);
	return r.json() as Promise<T>;
}
