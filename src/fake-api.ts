/**
 * Test helper: a stand-in atlas-api on a random port, and the real CLI run against it as a child
 * process (so exit codes and stderr are the real ones). `ATLAS_API` points the child here, so a
 * test can never reach the live daemon. Routes are `'METHOD /path'` → a JSON body or a Response.
 */
const CLI = new URL('./atlas.ts', import.meta.url).pathname;

export interface Call {
	method: string;
	path: string;
	body: unknown;
}

type Route = unknown | ((body: unknown, url: URL) => unknown);

export function fakeApi(routes: Record<string, Route>) {
	const calls: Call[] = [];
	const server = Bun.serve({
		port: 0,
		hostname: '127.0.0.1',
		async fetch(req) {
			const url = new URL(req.url);
			if (url.pathname === '/api/health') return Response.json({ ok: true });
			const body = req.method === 'GET' ? undefined : await req.json().catch(() => undefined);
			calls.push({ method: req.method, path: url.pathname + url.search, body });
			const route = routes[`${req.method} ${url.pathname}`];
			if (route === undefined) return Response.json({ error: `no fake for ${req.method} ${url.pathname}` }, { status: 404 });
			const out = typeof route === 'function' ? await route(body, url) : route;
			return out instanceof Response ? out : Response.json(out);
		}
	});
	return {
		calls,
		stop: () => server.stop(true),
		async cli(args: string[], cwd?: string) {
			const proc = Bun.spawn(['bun', CLI, ...args], {
				cwd,
				env: { ...process.env, ATLAS_API: `http://127.0.0.1:${server.port}` },
				stdin: 'ignore',
				stdout: 'pipe',
				stderr: 'pipe'
			});
			const [stdout, stderr, code] = await Promise.all([
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
				proc.exited
			]);
			return { stdout, stderr, code };
		},
		/** On a terminal: `script` gives the CLI a pty, and `answer` is typed at its first y/N prompt. */
		async tty(args: string[], answer: string) {
			// script refuses a socket on stdin (Bun's pipes are sockets), so `cat` feeds it a real pipe.
			// A CLI that never asks keeps cat waiting: the run then ends at the test's timeout.
			const proc = Bun.spawn(['/bin/sh', '-c', 'cat | /usr/bin/script -q /dev/null "$@"', 'sh', 'bun', CLI, ...args], {
				env: { ...process.env, ATLAS_API: `http://127.0.0.1:${server.port}` },
				stdin: 'pipe',
				stdout: 'pipe',
				stderr: 'pipe'
			});
			const decoder = new TextDecoder();
			let out = '';
			let asked = false;
			for await (const chunk of proc.stdout) {
				out += decoder.decode(chunk);
				if (!asked && out.includes('(y/N)')) {
					asked = true;
					proc.stdin.write(`${answer}\r`);
					proc.stdin.end(); // cat exits, so the pipeline ends with the CLI
				}
			}
			return { out: out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ''), code: await proc.exited };
		}
	};
}
