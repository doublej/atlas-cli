/** trim runner (timeout kills + waits, missing tool skip), schedule time math, plist generation. */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scratch = mkdtempSync(join(tmpdir(), 'atlas-disk-trim-'));
process.env.ATLAS_DISK_HOME = join(scratch, 'state');
process.env.ATLAS_DISK_PLIST_DIR = join(scratch, 'plists');
process.env.ATLAS_DISK_LAUNCH_AGENTS = join(scratch, 'agents');
process.env.ATLAS_DISK_LAUNCHCTL = '/usr/bin/false';
const { runProcess, runSteps } = await import('./trim-run');
const { nextRun, parseAt } = await import('./schedule-time');
const { plistXml, install, linkTarget, plistPath } = await import('./schedule-launchd');
const { pending, readLog } = await import('./oplog');

const alive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

describe('trim runner', () => {
	test('a timed-out step is killed with its whole process group, and waited for', async () => {
		const pidFile = join(scratch, 'grandchild.pid');
		// the grandchild ignores SIGTERM: only the SIGKILL escalation stops it
		const script = `sh -c 'trap "" TERM; echo $$ > ${pidFile}; sleep 999' & sleep 999`;
		const t0 = Date.now();
		const r = await runProcess(['sh', '-c', script], 0.5, 300);
		expect(r.timedOut).toBe(true);
		expect(Date.now() - t0).toBeLessThan(5000);
		const grandchild = Number(readFileSync(pidFile, 'utf8'));
		expect(alive(grandchild)).toBe(false);
	});

	test('batch: missing tool skipped, failure and timeout reported, the rest still runs, oplog closed', async () => {
		const steps = [
			{ name: 'missing', op: 'trim' as const, needs: ['no-such-tool-xyz'], cmd: ['no-such-tool-xyz'] },
			{ name: 'fails', op: 'trim' as const, needs: ['sh'], cmd: ['sh', '-c', 'exit 3'] },
			{ name: 'hangs', op: 'trim' as const, needs: ['sleep'], cmd: ['sleep', '999'], cache: scratch },
			{ name: 'ok', op: 'trim' as const, needs: ['true'], cmd: ['true'] }
		];
		const items = await runSteps(steps, 0.5);
		expect(items.map((i) => i.outcome)).toEqual(['skipped', 'failed', 'failed', 'done']);
		expect(items[0].reason).toContain('not installed: no-such-tool-xyz');
		expect(items[1].reason).toContain('exit 3');
		expect(items[2].timedOut).toBe(true);
		expect(items[2].reason).toMatch(/timed out after 0.5s.*cache/);
		expect(pending()).toHaveLength(0);
		expect(readLog().filter((r) => r.t === 'start')).toHaveLength(4);
	});
});

describe('schedule', () => {
	test('parseAt', () => {
		expect(parseAt('Sun 10:00')).toEqual({ weekday: 0, hour: 10, minute: 0 });
		expect(parseAt('wednesday 9:05')).toEqual({ weekday: 3, hour: 9, minute: 5 });
		expect(() => parseAt('Funday 10:00')).toThrow();
		expect(() => parseAt('Sun 25:00')).toThrow();
	});

	test('nextRun: later this week, next week, and exactly-now rolls over', () => {
		const wed = new Date(2026, 8, 23, 12, 0); // Wed 23 Sep 2026 12:00 local
		expect(nextRun({ enabled: true, weekday: 0, hour: 10, minute: 0 }, wed)).toEqual(new Date(2026, 8, 27, 10, 0));
		expect(nextRun({ enabled: true, weekday: 3, hour: 13, minute: 0 }, wed)).toEqual(new Date(2026, 8, 23, 13, 0));
		expect(nextRun({ enabled: true, weekday: 3, hour: 12, minute: 0 }, wed)).toEqual(new Date(2026, 8, 30, 12, 0));
	});

	test('plist lints, carries the calendar interval, and install links it (launchctl faked)', () => {
		const xml = plistXml('trim', { enabled: true, weekday: 0, hour: 11, minute: 30 });
		const file = join(scratch, 'check.plist');
		writeFileSync(file, xml);
		expect(Bun.spawnSync(['plutil', '-lint', file]).exitCode).toBe(0);
		const json = JSON.parse(Bun.spawnSync(['plutil', '-convert', 'json', '-o', '-', file]).stdout.toString());
		expect(json.StartCalendarInterval).toEqual({ Weekday: 0, Hour: 11, Minute: 30 });
		expect(json.ProgramArguments.slice(1)).toEqual(['trim', 'trim', '--scheduled']);
		expect(json.Label).toBe('com.jurrejan.atlas-disk-trim');
		expect(install('trim', { enabled: true, weekday: 0, hour: 11, minute: 30 })).toContain('bootstrap failed');
		expect(linkTarget('trim')).toBe(plistPath('trim'));
	});
});
