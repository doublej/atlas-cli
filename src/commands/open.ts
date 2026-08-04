import type { Command } from '../types';
import { API_BASE } from '../api';
import { ensureUp, openUrl } from '../util';

/** `atlas open` — open the atlas web UI in the browser. */
export const open: Command = {
	name: 'open',
	summary: 'open the atlas web UI in the browser',
	async run() {
		if (await ensureUp()) await openUrl(API_BASE);
		else console.log(`atlas-api still isn't running (${API_BASE}).`);
	}
};
