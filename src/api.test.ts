import { describe, expect, it } from 'bun:test';

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
