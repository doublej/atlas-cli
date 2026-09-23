/**
 * `atlas board speak` — reads the board aloud. Every author gets their own voice from the Chatterbox
 * voice library on Fractal, remembered in voices.json next to board.jsonl, and every post becomes
 * audio/NNNN.wav there. Posts that already have audio are skipped, so a rerun only speaks new ones.
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

/** What gets spoken: the subject, then the post. A reply's `#0003` reads as words. */
export const spokenText = (p: Post): string =>
	`${p.subject.replace(/^#0*(\d+)\s*/, 'Reply to message $1. ')}. ${p.text}`;

/** curl, not fetch: Bun is refused LAN addresses here (macOS Local Network privacy), curl is not. */
function curl(args: string[]): string {
	const r = Bun.spawnSync(['curl', '-sS', '--fail-with-body', '-m', '300', ...args]);
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
		const file = join(audioDir, `${String(i + 1).padStart(4, '0')}.wav`);
		if (existsSync(file)) continue;
		const body = JSON.stringify({ input: spokenText(post), voice: voiceOf[post.author] });
		curl(['-H', 'content-type: application/json', '-d', body, '-o', `${file}.part`, `${TTS_URL}/v1/audio/speech`]);
		renameSync(`${file}.part`, file); // a failed request never leaves a file that a rerun would skip
		console.log(`MSG ${msgNo(i + 1)}  ${post.author} → ${voiceOf[post.author]}  ${file}`);
	}
}
