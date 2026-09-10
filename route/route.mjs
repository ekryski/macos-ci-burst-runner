// Routes each runner class to self-hosted labels while an idle self-hosted
// runner matches, and to the class's GitHub-hosted fallback otherwise.
//
// GitHub has no native overflow from self-hosted to hosted runners: a job waits
// for a matching self-hosted runner for up to 24 hours. This step runs first,
// reads runner state, and hands later jobs a runs-on value. It is a snapshot:
// two runs routed at the same moment can both see one idle runner.

import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const CLASS_NAME = /^[A-Za-z0-9_-]+$/;

export function parseClasses(spec) {
  const classes = [];
  for (const raw of spec.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const colon = line.indexOf(':');
    if (colon < 1) throw new Error(`class line needs "name: labels": ${line}`);
    const name = line.slice(0, colon).trim();
    if (!CLASS_NAME.test(name)) throw new Error(`invalid class name: ${name}`);
    if (classes.some((c) => c.name === name)) throw new Error(`duplicate class: ${name}`);
    const [labelPart, fallbackPart] = line.slice(colon + 1).split('->');
    const labels = labelPart.split(',').map((l) => l.trim()).filter(Boolean);
    if (!labels.length) throw new Error(`class ${name} names no labels`);
    const fallback = (fallbackPart ?? '').trim();
    classes.push({ name, labels, fallback: fallback && fallback !== 'none' ? fallback : null });
  }
  if (!classes.length) throw new Error('no classes given');
  return classes;
}

// GitHub matches runs-on labels case-insensitively, and a runner qualifies only
// if it carries every one of them.
function matches(runner, labels) {
  const have = new Set((runner.labels ?? []).map((l) => String(l.name).toLowerCase()));
  return labels.every((l) => have.has(l.toLowerCase()));
}

export function decide(runners, classes, { minIdle = 1, force = '', why = 'forced' } = {}) {
  const targets = {};
  const decisions = {};
  for (const c of classes) {
    const matching = runners.filter((r) => matches(r, c.labels));
    const online = matching.filter((r) => r.status === 'online');
    const idle = online.filter((r) => !r.busy);
    let target;
    let reason;
    if (!c.fallback) { target = 'self-hosted'; reason = 'no fallback'; }
    else if (force === 'hosted' || force === 'self-hosted') { target = force; reason = why; }
    else if (idle.length >= minIdle) { target = 'self-hosted'; reason = `${idle.length} idle`; }
    else { target = 'hosted'; reason = `${idle.length} idle, ${minIdle} required`; }
    targets[c.name] = target === 'hosted' ? c.fallback : c.labels;
    decisions[c.name] = { target, reason, idle: idle.length, online: online.length, runsOn: targets[c.name] };
  }
  return { targets, decisions };
}

async function getAll(api, path, token, key) {
  const items = [];
  for (let page = 1; ; page++) {
    const sep = path.includes('?') ? '&' : '?';
    const res = await fetch(`${api}${path}${sep}per_page=100&page=${page}`, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
      },
    });
    if (!res.ok) throw new Error(`GET ${path} returned ${res.status}`);
    const batch = (await res.json())[key] ?? [];
    items.push(...batch);
    if (batch.length < 100) return items;
  }
}

export async function listRunners({ api, owner, token, group }) {
  const base = `/orgs/${encodeURIComponent(owner)}/actions`;
  if (!group) return getAll(api, `${base}/runners`, token, 'runners');
  const groups = await getAll(api, `${base}/runner-groups`, token, 'runner_groups');
  const found = groups.find((g) => g.name.toLowerCase() === group.toLowerCase());
  // A missing group is configuration, not an outage: routing blind would strand
  // jobs, so it must not be absorbed by the on-error policy.
  if (!found) { const e = new Error(`runner group not found: ${group}`); e.config = true; throw e; }
  return getAll(api, `${base}/runner-groups/${found.id}/runners`, token, 'runners');
}

function input(env, name, fallback = '') {
  return (env[`INPUT_${name.toUpperCase()}`] ?? fallback).trim();
}

export async function main(env = process.env) {
  const classes = parseClasses(input(env, 'classes'));
  const token = input(env, 'token');
  const owner = input(env, 'owner');
  const minIdle = Number.parseInt(input(env, 'min-idle', '1'), 10);
  if (!Number.isInteger(minIdle) || minIdle < 1) throw new Error('min-idle must be a positive integer');
  const force = input(env, 'force');
  if (force && force !== 'hosted' && force !== 'self-hosted') throw new Error(`invalid force: ${force}`);
  const onError = input(env, 'on-error', 'self-hosted');
  if (!['self-hosted', 'hosted', 'fail'].includes(onError)) throw new Error(`invalid on-error: ${onError}`);

  let result;
  try {
    // Dependabot and fork pull requests do not receive organization secrets, so
    // the token step yields nothing. That is an unreadable API, not bad input:
    // it must follow on-error rather than block every such pull request.
    if (!token) throw new Error('no token (secrets unavailable to this run?)');
    const runners = await listRunners({
      api: env.GITHUB_API_URL || 'https://api.github.com', owner, token, group: input(env, 'runner-group'),
    });
    result = decide(runners, classes, { minIdle, force });
  } catch (error) {
    if (error.config || onError === 'fail') throw error;
    console.log(`::warning::Runner API unavailable (${error.message}); routing per on-error=${onError}`);
    result = decide([], classes, { force: onError, why: 'runner API unavailable' });
  }

  for (const [name, d] of Object.entries(result.decisions)) {
    console.log(`${name}: ${d.target} (${d.reason}) -> ${JSON.stringify(d.runsOn)}`);
  }
  if (env.GITHUB_OUTPUT) {
    appendFileSync(env.GITHUB_OUTPUT, `targets=${JSON.stringify(result.targets)}\n`);
    appendFileSync(env.GITHUB_OUTPUT, `decisions=${JSON.stringify(result.decisions)}\n`);
  }
  if (env.GITHUB_STEP_SUMMARY) {
    const rows = Object.entries(result.decisions)
      .map(([n, d]) => `| ${n} | ${d.target} | ${d.idle} / ${d.online} | \`${JSON.stringify(d.runsOn)}\` |`);
    appendFileSync(env.GITHUB_STEP_SUMMARY,
      ['### Runner routing', '', '| Class | Target | Idle / online | runs-on |', '| --- | --- | --- | --- |', ...rows, ''].join('\n'));
  }
  return result;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.log(`::error::${error.message}`);
    process.exitCode = 1;
  });
}
