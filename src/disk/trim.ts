/**
 * `atlas disk trim [--dry-run] [--rust-sweep] [--unattended] [--scheduled] [--json]` — each
 * installed tool trims its own cache; the Rust sweep runs only when turned on.
 */
import { homedir } from 'node:os';
import { approve, modeOf, policy, trapCancel, type Mode } from './approval';
import { parseFlags, type Flags } from './flags';
import { freeBytes, human } from './fsutil';
import { acquire } from './lock';
import { renderItems, type ItemReport, type Report } from './report';
import { loadSettings, type Settings } from './settings';
import { runSteps, type Step } from './trim-run';
import { sweepSteps, toolSteps } from './trim-steps';

interface Plan {
	steps: Step[];
	/** Rust sweep asked for but not allowed. */
	refused: ItemReport[];
}

function planTrim(s: Settings, f: Flags, mode: Mode): Plan {
	const steps = toolSteps();
	if (!s.rustSweep && !f.has('rust-sweep')) return { steps, refused: [] };
	const v = policy('rust-sweep', mode, s, f);
	if (typeof v === 'object') return { steps, refused: [{ item: 'rust sweep', outcome: 'refused', reason: 'not turned on', needs: v.refuse }] };
	return { steps: [...steps, ...sweepSteps(s.devRoot, s.rustSweepDays, s.rustSweepMax)], refused: [] };
}

function renderPlan(p: Plan): string {
	const lines = p.steps.map((st) => `  ${st.skip ? '– skip' : '•'} ${st.name}${st.skip ? `  (${st.skip})` : ''}`);
	const refused = p.refused.length ? `\n${renderItems(p.refused)}` : '';
	return `Trim plan (${p.steps.length} steps):\n${lines.join('\n')}${refused}`;
}

function renderResult(items: ItemReport[], freedTotal: number, diskDelta: number): string {
	const caches = items
		.filter((i) => typeof i.cacheBefore === 'number')
		.map((i) => `  ${i.item.padEnd(34)} ${human(i.cacheBefore as number).padStart(9)} → ${human((i.cacheAfter as number) ?? 0).padStart(9)}`);
	return [renderItems(items), '', 'Caches (before → after):', ...caches, '', `Freed by steps: ${human(freedTotal)} · free space change: ${human(diskDelta)}`].join('\n');
}

export async function run(args: string[]): Promise<Report> {
	const f = parseFlags(args, ['rust-sweep']);
	const s = loadSettings();
	const mode = modeOf(f);
	const plan = planTrim(s, f, mode);
	const data = { plan: plan.steps.map((st) => ({ name: st.name, op: st.op, cmd: st.cmd, cache: st.cache, skip: st.skip })) };
	if (f.has('dry-run')) return { command: 'trim', exit: 'ok', items: plan.refused, data, text: renderPlan(plan) };
	if (mode === 'interactive') console.error(renderPlan(plan));
	const go = await approve(policy('trim', mode, s, f), `Run ${plan.steps.length} trim steps?`);
	if (go !== true) return { command: 'trim', items: plan.steps.map((st) => ({ item: st.name, outcome: 'refused', needs: go.refuse })), data };
	const holder = acquire('trim');
	if (holder) return { command: 'trim', exit: 'refused', data: { holder }, text: `Refused: job '${holder.job}' (pid ${holder.pid}, since ${holder.since}) is running.` };
	trapCancel();
	const freeBefore = freeBytes(homedir());
	const items = [...plan.refused, ...(await runSteps(plan.steps, s.stepTimeoutSec))];
	const diskDelta = freeBytes(homedir()) - freeBefore;
	const freedTotal = items.reduce((n, i) => n + (typeof i.freed === 'number' ? i.freed : 0), 0);
	return { command: 'trim', items, data: { ...data, freedTotal, diskDelta }, text: renderResult(items, freedTotal, diskDelta) };
}
