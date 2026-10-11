import { expect, test } from 'bun:test';
import { explainDown } from './util';

const PRINT = `gui/501/com.jurrejan.atlas-api = {
	working directory = /x/atlas-api
	stderr path = /tmp/atlas-api.error.log
	runs = 7265
	last exit code = 1
}`;

test('explainDown names the exit, the log line and the rebuild for a missing build', () => {
	const msg = explainDown(PRINT, 'error: Module not found "build/index.js"');
	expect(msg).toContain('started it 7265 times, last exit code 1');
	expect(msg).toContain('/tmp/atlas-api.error.log: error: Module not found');
	expect(msg).toContain('cd /x/atlas-api && bun run daemon:reload');
});

test('explainDown says when the job is not loaded at all', () => {
	expect(explainDown(null)).toContain("isn't loaded in launchd");
});
