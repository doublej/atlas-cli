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
	} catch (err) {
		// A timeout counts as up: the daemon answers health in ~20ms, so blowing 2s means the
		// machine is loaded, not that the process died, and a dead one refuses the connection
		// instantly rather than hanging. Counting slow as dead is what made `atlas scan` announce
		// "atlas-api isn't running" at a daemon with a day of uptime, kickstart it, then die.
		return (err as Error)?.name === 'TimeoutError';
	}
}

/**
 * What a failed call says: the body's `error` (every atlas-api route answers `{ error }`), else its
 * `message`, else `fallback` — never a non-JSON body, which for a missing route is a whole HTML page.
 */
async function errorText(r: Response, fallback: string): Promise<string> {
	const body = (await r.json().catch(() => null)) as { error?: unknown; message?: unknown } | null;
	if (typeof body?.error === 'string' && body.error) return body.error;
	if (typeof body?.message === 'string' && body.message) return body.message;
	return fallback;
}

/** The one place a call reaches the API. A non-2xx answer throws its own error text. */
async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
	const r = await fetch(`${API_BASE}${path}`, {
		method,
		...(method === 'GET'
			? {}
			: {
					headers: { 'content-type': 'application/json' },
					body: body === undefined ? undefined : JSON.stringify(body)
				})
	});
	if (!r.ok) throw new Error(await errorText(r, `${method} ${path} → ${r.status} ${r.statusText}`));
	return r.json() as Promise<T>;
}

export const apiGet = <T>(path: string): Promise<T> => request<T>('GET', path);
export const apiPost = <T>(path: string, body?: unknown): Promise<T> => request<T>('POST', path, body);
export const apiPatch = <T>(path: string, body?: unknown): Promise<T> => request<T>('PATCH', path, body);
export const apiDelete = <T>(path: string, body?: unknown): Promise<T> => request<T>('DELETE', path, body);
