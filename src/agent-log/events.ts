/** Journal event writers: begin (intent), finding, end. */
import {
	type Options,
	USAGE,
	die,
	parseDuration,
	requireOperation,
	requireScopes,
	validateSummary
} from './args';
import { currentActor } from './actor';
import { contextDetail, findIntent, insertEvent } from './store';

export type EndInput = {
	opId: string;
	outcome: string;
	summary: string;
	extra?: Record<string, unknown>;
};

export function begin(operation: string, options: Options, summary: string): string {
	requireOperation(operation);
	validateSummary(summary);
	const opId = `op-${crypto.randomUUID().slice(0, 12)}`;
	insertEvent({
		kind: 'intent',
		op_id: opId,
		operation,
		actor: currentActor(),
		bead: options.get('--bead')?.[0] ?? '',
		scopes: JSON.stringify(requireScopes(options)),
		summary,
		expires_ms: Date.now() + parseDuration(options.get('--ttl')?.[0] ?? '20m'),
		outcome: '',
		detail: contextDetail({ target: options.get('--target')?.[0] ?? '' })
	});
	return opId;
}

export function finding(options: Options, summary: string): void {
	const evidence = options.get('--evidence')?.[0];
	validateSummary(summary);
	if (!evidence) die(`finding needs --evidence\n${USAGE}`);
	insertEvent({
		kind: 'finding',
		op_id: '',
		operation: '',
		actor: currentActor(),
		bead: options.get('--bead')?.[0] ?? '',
		scopes: JSON.stringify(requireScopes(options)),
		summary,
		expires_ms: Date.now() + parseDuration(options.get('--ttl')?.[0] ?? '4h'),
		outcome: '',
		detail: contextDetail({ evidence })
	});
}

/**
 * Durable session handoff — never expires; the read side always shows the latest one.
 * Scopes are optional (a handoff usually spans the whole repo).
 */
export function handoff(options: Options, summary: string, extra: Record<string, unknown> = {}): void {
	validateSummary(summary);
	insertEvent({
		kind: 'handoff',
		op_id: '',
		operation: '',
		actor: currentActor(),
		bead: options.get('--bead')?.[0] ?? '',
		scopes: JSON.stringify(options.get('--scope') ?? []),
		summary,
		expires_ms: null,
		outcome: '',
		detail: contextDetail(extra)
	});
}

export function end(input: EndInput): void {
	if (!input.opId) die(`end needs an operation id\n${USAGE}`);
	if (!['ok', 'failed', 'cancelled'].includes(input.outcome)) die('invalid outcome');
	const intent = findIntent(input.opId);
	if (!intent) die(`unknown operation '${input.opId}'`);
	const summary = input.summary || intent.summary;
	validateSummary(summary);
	insertEvent({
		kind: 'end',
		op_id: input.opId,
		operation: intent.operation,
		actor: currentActor(),
		bead: intent.bead,
		scopes: intent.scopes,
		summary,
		expires_ms: null,
		outcome: input.outcome,
		detail: contextDetail({ duration_ms: Date.now() - intent.at_ms, ...input.extra })
	});
}
