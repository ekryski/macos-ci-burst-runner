import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseClasses, decide, main } from '../route/route.mjs';

const runner = (name, labels, { status = 'online', busy = false } = {}) =>
  ({ name, status, busy, labels: labels.map((n) => ({ name: n })) });

const CLASSES = parseClasses(`
  # comments and blank lines are ignored
  linux: self-hosted,Linux,ARM64,waffuru-linux -> ubuntu-24.04-arm
  macos: self-hosted,macOS,ARM64,waffuru-mac -> macos-26
  bench: self-hosted,macOS,ARM64,waffuru-metal -> none
  pinned: self-hosted,macOS
`);

test('parses classes, fallbacks, and "none"', () => {
  assert.deepEqual(CLASSES.map((c) => [c.name, c.fallback]),
    [['linux', 'ubuntu-24.04-arm'], ['macos', 'macos-26'], ['bench', null], ['pinned', null]]);
  assert.deepEqual(CLASSES[1].labels, ['self-hosted', 'macOS', 'ARM64', 'waffuru-mac']);
});

test('rejects malformed class specs', () => {
  assert.throws(() => parseClasses('no colon here'), /name: labels/);
  assert.throws(() => parseClasses('bad name!: a'), /invalid class name/);
  assert.throws(() => parseClasses('a: x\na: y'), /duplicate class/);
  assert.throws(() => parseClasses('a:  -> macos-26'), /no labels/);
  assert.throws(() => parseClasses('\n# only a comment\n'), /no classes/);
});

test('an idle match stays self-hosted; busy or offline matches fall back', () => {
  const { targets, decisions } = decide([
    runner('mini', ['self-hosted', 'macOS', 'ARM64', 'waffuru-mac']),
    runner('lx', ['self-hosted', 'Linux', 'ARM64', 'waffuru-linux'], { busy: true }),
    runner('lx2', ['self-hosted', 'Linux', 'ARM64', 'waffuru-linux'], { status: 'offline' }),
  ], CLASSES);
  assert.deepEqual(targets.macos, ['self-hosted', 'macOS', 'ARM64', 'waffuru-mac']);
  assert.equal(targets.linux, 'ubuntu-24.04-arm');
  assert.deepEqual([decisions.linux.idle, decisions.linux.online], [0, 1]);
});

test('labels match case-insensitively and must all be present', () => {
  const { targets } = decide([runner('m', ['SELF-HOSTED', 'macos', 'arm64', 'WAFFURU-MAC'])], CLASSES);
  assert.ok(Array.isArray(targets.macos));
  const partial = decide([runner('m', ['self-hosted', 'macOS', 'ARM64'])], CLASSES);
  assert.equal(partial.targets.macos, 'macos-26');
});

test('a drained burst Mac has withdrawn its labels and does not count', () => {
  // Off keeps only the always-present set, so it cannot satisfy the class.
  const { targets } = decide([runner('burst', ['self-hosted', 'macOS', 'ARM64'])], CLASSES);
  assert.equal(targets.macos, 'macos-26');
});

test('classes without a fallback stay self-hosted, even when forced', () => {
  const { targets } = decide([], CLASSES, { force: 'hosted' });
  assert.deepEqual(targets.bench, ['self-hosted', 'macOS', 'ARM64', 'waffuru-metal']);
  assert.deepEqual(targets.pinned, ['self-hosted', 'macOS']);
  assert.equal(targets.macos, 'macos-26');
});

test('min-idle and force', () => {
  const one = [runner('mini', ['self-hosted', 'macOS', 'ARM64', 'waffuru-mac'])];
  assert.equal(decide(one, CLASSES, { minIdle: 2 }).targets.macos, 'macos-26');
  assert.ok(Array.isArray(decide([], CLASSES, { force: 'self-hosted' }).targets.macos));
});

// --- main() against a mock API -------------------------------------------

function mockApi(routes) {
  return new Promise((resolve) => {
    const seen = [];
    const server = createServer((req, res) => {
      seen.push({ url: req.url, auth: req.headers.authorization });
      const url = new URL(req.url, 'http://x');
      const handler = routes[url.pathname];
      if (!handler) { res.writeHead(404); res.end('{}'); return; }
      const [status, body] = handler(url);
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    });
    server.listen(0, '127.0.0.1', () =>
      resolve({ api: `http://127.0.0.1:${server.address().port}`, seen, close: () => server.close() }));
  });
}

function env(api, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'route-test-'));
  const out = join(dir, 'output'); writeFileSync(out, '');
  const summary = join(dir, 'summary'); writeFileSync(summary, '');
  return {
    vars: {
      GITHUB_API_URL: api, GITHUB_OUTPUT: out, GITHUB_STEP_SUMMARY: summary,
      INPUT_TOKEN: 'test-token', INPUT_OWNER: 'acme',
      INPUT_CLASSES: 'macos: self-hosted,macOS,ARM64,waffuru-mac -> macos-26\nbench: self-hosted,macOS,waffuru-metal -> none',
      ...extra,
    },
    output: () => Object.fromEntries(readFileSync(out, 'utf8').trim().split('\n').map((l) => {
      const i = l.indexOf('='); return [l.slice(0, i), JSON.parse(l.slice(i + 1))];
    })),
    summary: () => readFileSync(summary, 'utf8'),
  };
}

test('pages through runners and writes outputs and a summary', async () => {
  const busy = Array.from({ length: 100 }, (_, i) =>
    runner(`busy-${i}`, ['self-hosted', 'macOS', 'ARM64', 'waffuru-mac'], { busy: true }));
  const api = await mockApi({
    '/orgs/acme/actions/runners': (u) => [200, {
      runners: u.searchParams.get('page') === '1' ? busy : [runner('idle', ['self-hosted', 'macOS', 'ARM64', 'waffuru-mac'])],
    }],
  });
  try {
    const e = env(api.api);
    await main(e.vars);
    const out = e.output();
    assert.deepEqual(out.targets.macos, ['self-hosted', 'macOS', 'ARM64', 'waffuru-mac']);
    assert.equal(out.decisions.macos.idle, 1);
    assert.equal(api.seen.length, 2, 'second page was not requested');
    assert.ok(api.seen.every((s) => s.auth === 'Bearer test-token'));
    assert.match(e.summary(), /\| macos \| self-hosted \| 1 \/ 101 \|/);
  } finally { api.close(); }
});

test('runner-group limits counting to that group', async () => {
  const api = await mockApi({
    '/orgs/acme/actions/runner-groups': () => [200, { runner_groups: [{ id: 1, name: 'Default' }, { id: 3, name: 'Home CI' }] }],
    '/orgs/acme/actions/runner-groups/3/runners': () => [200, { runners: [] }],
    // An idle runner exists org-wide, but not in the group this repo may use.
    '/orgs/acme/actions/runners': () => [200, { runners: [runner('elsewhere', ['self-hosted', 'macOS', 'ARM64', 'waffuru-mac'])] }],
  });
  try {
    const e = env(api.api, { 'INPUT_RUNNER-GROUP': 'home ci' });
    await main(e.vars);
    assert.equal(e.output().targets.macos, 'macos-26');
    assert.ok(!api.seen.some((s) => s.url.startsWith('/orgs/acme/actions/runners')), 'counted org-wide runners');
  } finally { api.close(); }
});

test('a missing runner group fails instead of routing blind', async () => {
  const api = await mockApi({ '/orgs/acme/actions/runner-groups': () => [200, { runner_groups: [] }] });
  try {
    await assert.rejects(main(env(api.api, { 'INPUT_RUNNER-GROUP': 'Home CI', 'INPUT_ON-ERROR': 'hosted' }).vars), /runner group not found/);
  } finally { api.close(); }
});

test('an unreadable API follows on-error, defaulting to self-hosted', async () => {
  const api = await mockApi({ '/orgs/acme/actions/runners': () => [401, { message: 'Bad credentials' }] });
  try {
    const quiet = env(api.api);
    await main(quiet.vars);
    assert.ok(Array.isArray(quiet.output().targets.macos), 'default must not spend hosted minutes');

    const hosted = env(api.api, { 'INPUT_ON-ERROR': 'hosted' });
    await main(hosted.vars);
    assert.equal(hosted.output().targets.macos, 'macos-26');
    assert.ok(Array.isArray(hosted.output().targets.bench), 'a no-fallback class must stay self-hosted');

    await assert.rejects(main(env(api.api, { 'INPUT_ON-ERROR': 'fail' }).vars), /401/);
  } finally { api.close(); }
});

test('a missing token follows on-error instead of blocking the run', async () => {
  // Dependabot and fork pull requests get no organization secrets.
  const e = env('http://127.0.0.1:9', { INPUT_TOKEN: '' });
  await main(e.vars);
  assert.ok(Array.isArray(e.output().targets.macos));
  await assert.rejects(main(env('http://127.0.0.1:9', { INPUT_TOKEN: '', 'INPUT_ON-ERROR': 'fail' }).vars), /no token/);
});

test('rejects bad inputs before calling the API', async () => {
  await assert.rejects(main(env('http://127.0.0.1:9', { 'INPUT_MIN-IDLE': '0' }).vars), /min-idle/);
  await assert.rejects(main(env('http://127.0.0.1:9', { INPUT_FORCE: 'maybe' }).vars), /invalid force/);
});
