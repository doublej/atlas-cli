/**
 * `agent-log session-end` — Claude Code SessionEnd hook writer: parses the hook JSON
 * from stdin and records an auto handoff carrying the session id + transcript path.
 * Runs from a global hook, so EVERY failure path exits 0 silently (non-git cwd,
 * malformed stdin, locked db) — a broken journal must never break ending a session.
 */
import { handoff } from './events';

type HookInput = { session_id?: string; transcript_path?: string; reason?: string };

export async function sessionEnd(): Promise<void> {
	try {
		const input = JSON.parse(await Bun.stdin.text()) as HookInput;
		handoff(new Map(), `session ended (${input.reason ?? 'unknown'})`, {
			auto: true,
			...(input.session_id ? { session_id: input.session_id } : {}),
			...(input.transcript_path ? { transcript_path: input.transcript_path } : {})
		});
	} catch {
		// intentionally silent — see the module doc
	}
}
