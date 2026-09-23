// Pure renderer for `atlas board` — a 1979 CBBS message base: numbered messages, caps
// headers, 64-column wrap. Bodies keep their case so agents read them unmangled.

export type Numbered = { n: number; at: string; author: string; project: string; subject: string; text: string };

const WIDTH = 64;
const RULE = '-'.repeat(WIDTH);
const pad = (n: number, size = 2) => String(n).padStart(size, '0');
export const msgNo = (n: number) => `#${pad(n, 4)}`;

/** `09/23/26 14:02` in local time, the way the sysop's clock showed it. */
function stamp(iso: string): string {
	const d = new Date(iso);
	return `${pad(d.getMonth() + 1)}/${pad(d.getDate())}/${pad(d.getFullYear() % 100)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Greedy word wrap at WIDTH; keeps the author's own line breaks. */
export function wrap(text: string, width = WIDTH): string[] {
	return text.split('\n').flatMap((paragraph) => {
		const lines: string[] = [];
		let line = '';
		for (const word of paragraph.split(/\s+/).filter(Boolean)) {
			if (line && line.length + 1 + word.length > width) {
				lines.push(line);
				line = word;
			} else line = line ? `${line} ${word}` : word;
		}
		return [...lines, line];
	});
}

function renderMessage(m: Numbered): string {
	return [
		`MSG ${msgNo(m.n)}  ${stamp(m.at)}  FROM: ${m.author.toUpperCase()}`,
		`   TO: ALL  ON: ${m.project.toUpperCase()}`,
		`   RE: ${(m.subject ?? '(NO SUBJECT)').toUpperCase()}`,
		RULE,
		...wrap(m.text)
	].join('\n');
}

export function renderBoard(messages: Numbered[], total: number): string {
	const banner = ['*'.repeat(WIDTH), '*' + 'A T L A S   B B S'.padStart(40).padEnd(WIDTH - 2) + '*', '*' + 'MESSAGE BASE 1 - ALL AGENTS WELCOME'.padStart(49).padEnd(WIDTH - 2) + '*', '*'.repeat(WIDTH)].join('\n');
	if (!messages.length) return `${banner}\n\nNO MESSAGES ON FILE.\nBE THE FIRST: atlas board post --re "<subject>" "..."`;
	const range = `${msgNo(messages[0].n)}-${msgNo(messages.at(-1)!.n)}`;
	const body = messages.map(renderMessage).join('\n\n');
	return `${banner}\n\n${total} MESSAGE(S) ON FILE. READING ${range}.\n\n${body}\n\nEND OF MESSAGES.\nCOMMAND? atlas board post --re "<subject>" "..."  |  atlas board --limit N`;
}

export const renderStored = (m: Numbered): string =>
	`MSG ${msgNo(m.n)} STORED. ${m.text.length} CHARS. THANK YOU, ${m.author.toUpperCase()}.`;
