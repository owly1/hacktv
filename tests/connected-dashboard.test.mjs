import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {createApp, MemoryStorage} from '../backend/server.mjs';

test('the connected dashboard and home serve all local script and style dependencies', async t => {
  const server = http.createServer(createApp({
    ingestToken: 'static-test-ingest', dashboardToken: 'static-test-dashboard',
    allowedOrigins: [], storage: new MemoryStorage(),
    staticDir: fileURLToPath(new URL('../dist/', import.meta.url)),
  }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const route of ['/', '/bosco/index.html', '/bosco/dashboard.html', '/home.html']) {
    const response = await fetch(base + route);
    assert.equal(response.status, 200, route);
    const html = await response.text();
    const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
    assert.equal(new Set(ids).size, ids.length, `${route}: unique control IDs`);
    const assets = [...html.matchAll(/<(?:script|link)\b[^>]*(?:src|href)="([^"]+)"/g)].map(match => match[1]);
    for (const asset of assets) {
      const url = new URL(asset, base + route);
      if (url.origin !== base) continue;
      const result = await fetch(url);
      assert.equal(result.status, 200, `${route}: ${asset}`);
      assert.ok((await result.text()).length > 0, `${asset}: nonempty response`);
    }
    if (route === '/') {
      assert.ok(assets.includes('app.js') && assets.includes('people.js') && assets.includes('demo-scout.js'));
      assert.doesNotMatch(html, /fixtures\.js/);
    }
    if (route === '/bosco/index.html') {
      assert.match(html, /href="\.\.\/\?demo"/);
      assert.match(html, /href="\.\.\/"/);
    }
  }
});

test('old preview bookmarks preserve mode, case and section when forwarded to the shared dashboard', async () => {
  const source = await readFile(new URL('../dist/bosco/dashboard-redirect.js', import.meta.url), 'utf8');
  for (const search of ['', '?demo', '?demo&case=forest-detection', '?live-demo']) {
    let target;
    vm.runInNewContext(source, {location: {search, hash: '#drone-panel', replace(url) { target = url; }}});
    assert.equal(new URL(target, 'http://localhost/bosco/dashboard.html').href, `http://localhost/${search}#drone-panel`);
  }
});
