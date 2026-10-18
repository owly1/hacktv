import { test } from 'node:test';
import assert from 'node:assert/strict';
import { options, probe } from '../scripts/demo.mjs';

test('demo launcher uses the same port options on Mac and Windows', () => {
  assert.deepEqual(options([], { PORT: '8787' }), { port: 8787, open: true });
  assert.equal(options(['--port','9000'], { PORT:'8787' }).port, 9000);
  assert.equal(options(['-Port','9000'], {}).port, 9000);
  assert.equal(options(['--no-open'], {}).open, false);
  assert.equal(options(['--live'], {}).live, true);
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
  assert.equal(calls[2].url, 'http://local/api/demo/people');
  assert.equal(calls[2].config.method, 'GET');
  assert.equal(calls[2].config.headers, undefined);
});

test('demo launcher refuses a backend that supports analysis but has no people demo', async () => {
  const calls = [];
  await assert.rejects(probe('http://local', async (url, config) => {
    calls.push({url, config});
    return {status: url.endsWith('/api/demo/people') ? 404 : 401};
  }), /older or incompatible backend.*people demo/);
  assert.equal(calls.at(-1).url, 'http://local/api/demo/people');
});

test('demo launcher reuses only the checkout whose dashboard files match', async () => {
  const assets = [['/', '<html>People rescue leads</html>'], ['/people.js', 'current people code']];
  const fixture = wrongRoute => async (url, config) => {
    if (url.includes('/api/')) {
      assert.equal(config.headers, undefined);
      return {status:401};
    }
    const route = new URL(url).pathname;
    return {ok:true, text:async () => route === wrongRoute ? 'old checkout' : assets.find(([p]) => p === route)?.[1]};
  };
  assert.equal(await probe('http://local', fixture(null), assets), true);
  for (const route of ['/', '/people.js']) {
    await assert.rejects(probe('http://local', fixture(route), assets), /different or outdated checkout/);
  }
});
