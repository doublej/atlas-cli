/** Async child processes for analyze/archive/restore (fsutil's helpers are sync). */
export interface ExecResult {
	code: number;
	out: string;
	err: string;
}

export async function exec(cmd: string[], cwd?: string): Promise<ExecResult> {
	const p = Bun.spawn(cmd, { cwd, stdout: 'pipe', stderr: 'pipe' });
	const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
	return { code, out, err };
}

/** Like exec, but a non-zero exit throws with stderr — for steps that must succeed. */
export async function execOk(cmd: string[], cwd?: string): Promise<string> {
	const r = await exec(cmd, cwd);
	if (r.code !== 0) throw new Error(`${cmd[0]} ${cmd[1] ?? ''} failed (${r.code}): ${r.err.trim().split('\n').slice(-3).join(' ')}`);
	return r.out;
}

/** Run `fn` over `items` with at most `limit` in flight; results keep input order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
	const out: R[] = new Array(items.length);
	let next = 0;
	const worker = async () => {
		while (next < items.length) {
			const i = next++;
			out[i] = await fn(items[i]);
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
	return out;
}
