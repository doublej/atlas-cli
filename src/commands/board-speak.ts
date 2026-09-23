/**
 * `atlas board speak` — reads the board aloud. Every author gets their own voice from the Chatterbox
 * voice library on Fractal, remembered in voices.json next to board.jsonl, and every post becomes
 * audio/NNNN.wav there, spoken from a Haiku-written script (NNNN.txt) that turns commands, paths and
 * symbols into words. Posts that already have audio are skipped, so a rerun only speaks new ones.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { die } from '../util';
import { msgNo } from '../board-format';
import { boardPath, readPosts, type Post } from './board';

const TTS_URL = process.env.ATLAS_TTS_URL ?? 'http://fractal.local:4123';

/** Keep existing assignments; a new author gets the least-used voice, first in the list on a tie. */
export function assignVoices(authors: string[], voices: string[], known: Record<string, string>): Record<string, string> {
	const assigned = { ...known };
	const uses = new Map(voices.map((v) => [v, 0]));
	for (const v of Object.values(assigned)) if (uses.has(v)) uses.set(v, uses.get(v)! + 1);
	for (const author of authors) {
		if (assigned[author] && uses.has(assigned[author])) continue;
		const voice = voices.reduce((best, v) => (uses.get(v)! < uses.get(best)! ? v : best));
		assigned[author] = voice;
		uses.set(voice, uses.get(voice)! + 1);
	}
	return assigned;
}

const SPEECH_PROMPT = `You turn a message-board post into a script for a text-to-speech voice. Every word you output will be spoken aloud, so the output must be plain spoken English and nothing else.

Keep the author's meaning, tone and wording. Change only what a person could not naturally say out loud:
- Commands, code, flags, file paths, URLs, environment variables, tool and package names: drop them, or say in a few plain words what they are or do. "git status" becomes "the git status", "BEEPER_ACCESS_TOKEN_READ" becomes "the read-only Beeper token", "mcpick-plus-proxy is not on PATH" becomes "the proxy tool wasn't installed".
- Agent names like TEAL-IBIS or teal-ibis become two lowercase words: "teal ibis".
- Message numbers like #0003 become "message three".
- Symbols, arrows, brackets and abbreviations become the words a person would say, or disappear.

Output only the rewritten text. No preamble, no quotes, no markdown.`;

/** Haiku rewrites the subject and post into words only: no commands, paths or symbols reach the voice. */
function spokenText(p: Post): string {
	const r = Bun.spawnSync(
		['claude', '-p', '--model', 'haiku', '--setting-sources', '', '--strict-mcp-config', '--tools', '', '--no-session-persistence', '--disable-slash-commands', '--system-prompt', SPEECH_PROMPT],
		{ stdin: Buffer.from(`${p.subject}. ${p.text}`), env: { ...process.env, MAX_THINKING_TOKENS: '0' } } // thinking turns 3s into 60s
	);
	const text = r.stdout.toString().trim();
	if (r.exitCode !== 0 || !text) die(`board speak: haiku pass failed: ${r.stderr.toString().trim() || text}`);
	return text;
}

/** curl, not fetch: Bun is refused LAN addresses here (macOS Local Network privacy), curl is not. Retries: a finished response sometimes never arrives. */
function curl(args: string[]): string {
	const r = Bun.spawnSync(['curl', '-sS', '--fail-with-body', '-m', '180', '--retry', '2', '--retry-all-errors', ...args]);
	if (r.exitCode !== 0) die(`board speak: ${r.stderr.toString().trim()} ${r.stdout.toString().slice(0, 300)}`);
	return r.stdout.toString();
}

function fetchVoices(): string[] {
	const { voices } = JSON.parse(curl([`${TTS_URL}/voices`])) as { voices: { name: string }[] };
	if (!voices.length) die('board speak: the Chatterbox voice library is empty');
	return voices.map((v) => v.name).sort();
}

export function speak(): void {
	const dir = dirname(boardPath());
	const audioDir = join(dir, 'audio');
	const mapPath = join(dir, 'voices.json');
	mkdirSync(audioDir, { recursive: true });

	const posts = readPosts();
	const known = existsSync(mapPath) ? (JSON.parse(readFileSync(mapPath, 'utf-8')) as Record<string, string>) : {};
	const voiceOf = assignVoices([...new Set(posts.map((p) => p.author))], fetchVoices(), known);
	writeFileSync(mapPath, JSON.stringify(voiceOf, null, '\t') + '\n');

	for (const [i, post] of posts.entries()) {
		const stem = join(audioDir, String(i + 1).padStart(4, '0'));
		const file = `${stem}.wav`;
		if (existsSync(file)) continue;
		if (!existsSync(`${stem}.txt`)) writeFileSync(`${stem}.txt`, spokenText(post) + '\n'); // the script, kept to read and to skip haiku on a retry
		const body = JSON.stringify({ input: readFileSync(`${stem}.txt`, 'utf-8').trim(), voice: voiceOf[post.author] });
		curl(['-H', 'content-type: application/json', '-d', body, '-o', `${file}.part`, `${TTS_URL}/v1/audio/speech`]);
		renameSync(`${file}.part`, file); // a failed request never leaves a file that a rerun would skip
		console.log(`MSG ${msgNo(i + 1)}  ${post.author} → ${voiceOf[post.author]}  ${file}`);
	}
}
