import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test';

/** `isUp` reads API_BASE at import time, so each case needs its own module instance. */
async function isUpAgainst(base: string): Promise<boolean> {
	process.env.ATLAS_API = base;
	const { isUp } = await import(`./api.ts?base=${encodeURIComponent(base)}`);
	return isUp();
}

describe('isUp', () => {
	it('is false when the port refuses the connection', async () => {
		expect(await isUpAgainst('http://127.0.0.1:1')).toBe(false);
	});

	it('is true when the server accepts but answers too slowly', async () => {
		// A busy daemon must not read as a dead one: that spurious "isn't running" is what
		// kickstarted a healthy daemon and killed the command.
		const server = Bun.serve({ port: 0, fetch: () => new Promise<Response>(() => {}) });
		try {
			expect(await isUpAgainst(`http://127.0.0.1:${server.port}`)).toBe(true);
		} finally {
			server.stop(true);
		}
	}, 10_000);
});

describe('request errors', () => {
	const answer = (body: string, status: number, statusText = 'Bad Request') =>
		spyOn(globalThis, 'fetch').mockResolvedValue(new Response(body, { status, statusText }));
	afterEach(() => mock.restore());

	it("throws the body's error, not the status line", async () => {
		answer(JSON.stringify({ error: "path is not in this machine's catalog" }), 400);
		const { apiGet } = await import('./api');
		await expect(apiGet('/api/atlas?path=/tmp')).rejects.toThrow("path is not in this machine's catalog");
	});

	it('falls back to message, then the text, then the status line', async () => {
		const { apiPatch, apiPost, apiDelete } = await import('./api');
		answer(JSON.stringify({ message: 'slug is taken' }), 409, 'Conflict');
		await expect(apiPatch('/api/atlas', {})).rejects.toThrow('slug is taken');
		answer('upstream down', 502, 'Bad Gateway');
		await expect(apiPost('/api/run', {})).rejects.toThrow('upstream down');
		answer('', 500, 'Internal Server Error');
		await expect(apiDelete('/api/run', {})).rejects.toThrow('DELETE /api/run → 500 Internal Server Error');
	});

	it('sends PATCH with a JSON body and returns the parsed answer', async () => {
		const spy = answer(JSON.stringify({ atlas: { slug: 'x' } }), 200, 'OK');
		const { apiPatch } = await import('./api');
		expect(await apiPatch<{ atlas: { slug: string } }>('/api/atlas', { path: '/p', patch: { slug: 'x' } })).toEqual({ atlas: { slug: 'x' } });
		const [, init] = spy.mock.calls[0] as [string, RequestInit];
		expect(init.method).toBe('PATCH');
		expect(JSON.parse(String(init.body))).toEqual({ path: '/p', patch: { slug: 'x' } });
	});
});
