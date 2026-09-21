/**
 * iCloud Drive storage state via NSURL resource keys (JXA + the ObjC bridge), every path in
 * one osascript call. `brctl status` answers "Client zone not found" for valid paths, so it
 * is never used. A path outside iCloud is `na`; osascript failing is `unknown`.
 */
import { statSync } from 'node:fs';
import type { Storage } from './types';
import { exec, execOk } from './archive-exec';

const JXA = `ObjC.import('Foundation');
function run(argv) {
	const keys = ['NSURLIsUbiquitousItemKey', 'NSURLUbiquitousItemIsUploadedKey', 'NSURLUbiquitousItemIsUploadingKey', 'NSURLUbiquitousItemDownloadingStatusKey'];
	return JSON.stringify(argv.map((p) => {
		const url = $.NSURL.fileURLWithPath(p);
		return keys.map((k) => {
			const ref = Ref();
			if (!url.getResourceValueForKeyError(ref, $[k], null)) return null;
			const v = ref[0];
			return v === undefined || v === null || (v.isNil && v.isNil()) ? null : ObjC.unwrap(v);
		});
	}));
}`;

type Keys = [boolean | null, boolean | null, boolean | null, string | null];

export function storageOf([ubiquitous, uploaded, uploading, status]: Keys): Storage {
	if (!ubiquitous) return 'na';
	if (status === 'NSURLUbiquitousItemDownloadingStatusNotDownloaded') return 'cloud';
	if (uploading) return 'uploading';
	return uploaded ? 'uploaded' : 'local';
}

export async function storageStates(paths: string[]): Promise<Storage[]> {
	if (!paths.length) return [];
	const r = await exec(['osascript', '-l', 'JavaScript', '-e', JXA, ...paths]);
	if (r.code !== 0) return paths.map(() => 'unknown');
	return (JSON.parse(r.out) as Keys[]).map(storageOf);
}

/** Bytes the file occupies on this Mac right now (allocated blocks; 0 when evicted). */
export const localBytes = (path: string): number => statSync(path).blocks * 512;

/** `brctl download`, then poll until materialized, printing progress to stderr. */
export async function download(file: string, size: number, stallSec = 300): Promise<void> {
	await execOk(['brctl', 'download', file]);
	let last = -1;
	let stalled = 0;
	while ((await storageStates([file]))[0] === 'cloud') {
		const have = localBytes(file);
		process.stderr.write(`\r  downloading ${file.split('/').pop()}: ${Math.round((100 * have) / Math.max(size, 1))}%   `);
		stalled = have === last ? stalled + 1 : 0;
		if (stalled >= stallSec) throw new Error(`iCloud download stalled for ${stallSec}s`);
		last = have;
		await Bun.sleep(1000);
	}
	process.stderr.write('\r  downloaded.                                   \n');
}

/** Drop the local copy of an uploaded file (it stays in iCloud). */
export const evict = (file: string): Promise<string> => execOk(['brctl', 'evict', file]);
