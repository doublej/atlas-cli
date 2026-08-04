// Thin client to the project-atlas API. Override the host with ATLAS_API.
export const API_BASE = process.env.ATLAS_API ?? 'http://localhost:47891';

/** Is atlas-api reachable right now? (1s timeout, never throws.) */
export async function isUp(): Promise<boolean> {
	try {
		const r = await fetch(`${API_BASE}/`, { signal: AbortSignal.timeout(1000) });
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
