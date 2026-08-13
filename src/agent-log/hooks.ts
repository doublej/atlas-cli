/**
 * Harness hook normalization — one internal event shape for Claude Code and
 * Codex payloads (read from stdin by `atlas agent-log hook`). Field mapping is
 * defensive on purpose: payloads evolve, and a hook must never crash the harness.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type Harness = 'claude' | 'codex';

export const HOOK_EVENTS = [
	'SessionStart',
	'UserPromptSubmit',
	'PreToolUse',
	'PostToolUse',
	'SubagentStart',
	'SubagentStop',
	'PreCompact',
	'PostCompact',
	'Stop',
	'SessionEnd',
	'Notification',
	'UserPromptError'
] as const;

export type HookEvent = (typeof HOOK_EVENTS)[number];

export type HookInput = {
	harness: Harness;
	event: HookEvent;
	sessionId?: string;
	transcriptPath?: string;
	cwd?: string;
	toolName?: string;
	toolInput?: Record<string, unknown>;
	toolCallId?: string;
	prompt?: string;
	subagentType?: string;
	parentToolCallId?: string;
	stopHookActive?: boolean;
	trigger?: string;
	reason?: string;
	raw: Record<string, unknown>;
};

const parseObject = (value: unknown): Record<string, unknown> | undefined => {
	if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
	if (typeof value === 'string') {
		try {
			return JSON.parse(value) as Record<string, unknown>;
		} catch {
			return undefined;
		}
	}
	return undefined;
};

const pick = (raw: Record<string, unknown>, keys: string[]): string | undefined => {
	for (const key of keys) {
		const value = raw[key];
		if (typeof value === 'string' && value) return value;
	}
	return undefined;
};

/** Claude Code hook_input on stdin → internal event. */
function fromClaude(event: HookEvent, raw: Record<string, unknown>): HookInput {
	return {
		harness: 'claude',
		event,
		sessionId: pick(raw, ['session_id', 'hook_callback_id']),
		transcriptPath: pick(raw, ['transcript_path']),
		cwd: pick(raw, ['cwd']),
		toolName: pick(raw, ['tool_name']),
		toolInput: parseObject(raw.tool_input),
		toolCallId: pick(raw, ['tool_call_id']),
		prompt: pick(raw, ['prompt']),
		subagentType: pick(raw, ['subagent_type']),
		parentToolCallId: pick(raw, ['parent_tool_call_id']),
		stopHookActive: Boolean(raw.stop_hook_active),
		trigger: pick(raw, ['trigger']),
		reason: pick(raw, ['reason']),
		raw
	};
}

/** Codex hook payload on stdin → internal event (event_type / tool_use_id naming). */
function fromCodex(event: HookEvent, raw: Record<string, unknown>): HookInput {
	return {
		harness: 'codex',
		event,
		sessionId: pick(raw, ['session_id', 'session']),
		transcriptPath: pick(raw, ['transcript_path', 'conversation_path']),
		cwd: pick(raw, ['cwd', 'working_directory']),
		toolName: pick(raw, ['tool_name', 'tool']),
		toolInput: parseObject(raw.tool_input ?? raw.input),
		toolCallId: pick(raw, ['tool_use_id', 'tool_call_id']),
		prompt: pick(raw, ['prompt', 'message']),
		subagentType: pick(raw, ['subagent_type', 'agent_type']),
		parentToolCallId: pick(raw, ['parent_tool_call_id']),
		stopHookActive: Boolean(raw.stop_hook_active),
		trigger: pick(raw, ['trigger']),
		reason: pick(raw, ['reason']),
		raw
	};
}

/** Hook event from harness name + stdin JSON. Unknown events pass through. */
export function parseHookInput(harness: Harness, event: string, raw: Record<string, unknown>): HookInput {
	const normalized = (HOOK_EVENTS as readonly string[]).includes(event)
		? (event as HookEvent)
		: 'Notification';
	return harness === 'codex' ? fromCodex(normalized, raw) : fromClaude(normalized, raw);
}

/** Retry-proof key: duplicate delivery of the same (harness, session, tool-use, phase) runs once. */
export function idempotencyKey(input: HookInput): string {
	const prompt = input.prompt ? createHash('sha256').update(input.prompt).digest('hex').slice(0, 8) : '';
	const parts = [
		input.harness,
		input.event,
		input.sessionId ?? '',
		input.toolCallId ?? '',
		input.transcriptPath ?? '',
		prompt
	];
	return createHash('sha256').update(parts.join('|')).digest('hex');
}

/** Hooks the coordination model wants installed. Keyed by the Claude Code event name. */
export const EXPECTED_HOOKS: Record<string, string> = {
	SessionStart: 'atlas agent-log hook SessionStart',
	UserPromptSubmit: 'atlas agent-log hook UserPromptSubmit',
	PreToolUse: 'atlas agent-log hook PreToolUse',
	PostToolUse: 'atlas agent-log hook PostToolUse',
	SubagentStart: 'atlas agent-log hook SubagentStart',
	SubagentStop: 'atlas agent-log hook SubagentStop',
	PreCompact: 'atlas agent-log hook PreCompact',
	PostCompact: 'atlas agent-log hook PostCompact',
	Stop: 'atlas agent-log hook Stop',
	SessionEnd: 'atlas agent-log session-end'
};

/** Which of the expected hooks are installed in ~/.claude/settings.json (doctor + install). */
export function hookCoverage(): { installed: string[]; missing: string[] } {
	const settingsPath = join(homedir(), '.claude', 'settings.json');
	if (!existsSync(settingsPath)) return { installed: [], missing: Object.keys(EXPECTED_HOOKS) };
	try {
		const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
			hooks?: Record<string, { hooks?: { command?: string }[] }[]>;
		};
		const installed: string[] = [];
		const missing: string[] = [];
		for (const [event, command] of Object.entries(EXPECTED_HOOKS)) {
			const present = (settings.hooks?.[event] ?? []).some((entry) =>
				entry.hooks?.some((hook) => hook.command === command)
			);
			(present ? installed : missing).push(event);
		}
		return { installed, missing };
	} catch {
		return { installed: [], missing: Object.keys(EXPECTED_HOOKS) };
	}
}