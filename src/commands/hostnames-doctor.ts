// `atlas hostnames doctor [--fix]` — the drift report of contract C.2, and its repair.
import { apiGet, apiPost } from '../api';

export interface DriftItem {
	id: string;
	kind: string;
	slug?: string;
	path?: string;
	detail: string;
	/** null = report only (e.g. a NAS file that isn't ours). */
	fix: { label: string } | null;
}

interface DoctorFix {
	results: { id: string; ok: boolean; error?: string }[];
	/** What remains. */
	items: DriftItem[];
}

export const driftLine = (i: DriftItem): string =>
	`${(i.slug ?? i.path ?? '-').padEnd(24)} ${i.kind.padEnd(16)} ${i.detail}  → ${i.fix?.label ?? 'report only'}`;

export function renderDoctor(items: DriftItem[]): string {
	if (!items.length) return 'No hostname drift.';
	const fixable = items.some((i) => i.fix);
	return [...items.map(driftLine), ...(fixable ? ['', 'Fix: atlas hostnames doctor --fix'] : [])].join('\n');
}

/** Without `fix` it only reads. Exit 1 while any drift remains, fixable or not. */
export async function doctor(fix: boolean, json: boolean): Promise<void> {
	if (!fix) {
		const report = await apiGet<{ checkedAt: string; items: DriftItem[] }>('/api/hostnames/doctor');
		console.log(json ? JSON.stringify(report) : renderDoctor(report.items));
		if (report.items.length) process.exitCode = 1;
		return;
	}
	const res = await apiPost<DoctorFix>('/api/hostnames/doctor', {});
	if (json) console.log(JSON.stringify(res));
	else {
		const done = res.results.map((r) => (r.ok ? `✓ ${r.id}` : `✗ ${r.id}  — ${r.error ?? 'failed'}`));
		const left = res.items.length ? ['', `Still drifting (${res.items.length}):`, ...res.items.map(driftLine)] : [];
		console.log([...(done.length ? done : ['Nothing to fix.']), ...left].join('\n'));
	}
	if (res.items.length) process.exitCode = 1;
}
