import { test } from 'node:test';
import assert from 'node:assert/strict';
import { options, probe } from '../scripts/demo.mjs';

test('demo launcher uses the same port options on Mac and Windows', () => {
  assert.deepEqual(options([], { PORT: '8787' }), { port: 8787, open: true });
  assert.equal(options(['--port','9000'], { PORT:'8787' }).port, 9000);
  assert.equal(options(['-Port','9000'], {}).port, 9000);
  assert.equal(options(['--no-open'], {}).open, false);
  for (const args of [['--port'], ['--port','0'], ['--port','65536'], ['--oops']]) assert.throws(() => options(args, {}));
});
test('demo launcher refuses an old backend and probes without credentials or inference', async () => {
  assert.equal(await probe('http://local', async () => { throw Error('offline'); }), false);
  for (const status of [200, 404, 500]) {
    await assert.rejects(probe('http://local', async () => ({status})), /incompatible/);
  }
  const calls = [];
  assert.equal(await probe('http://local', async (url, config) => {
    calls.push({url, config}); return {status:401};
  }), true);
  assert.equal(calls[1].url, 'http://local/api/demo/analyze');
  assert.equal(calls[1].config.method, 'POST');
  assert.equal(calls[1].config.headers, undefined);
});
