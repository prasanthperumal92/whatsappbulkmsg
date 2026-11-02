#!/usr/bin/env node
// Sanity checks for the eval suite itself (no app code needed):
//  1. every golden file is valid JSON with unique case ids
//  2. every FR-* id in SPEC.md is covered by at least one eval
//  3. every SPEC GAP id referenced in evals is listed in README.md
//  4. every eval named in TASKS.md exists, and every scenario is assigned to a task
//
//   node evals/check.mjs

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(p, 'utf8');
const problems = [];

const ids = new Set();
let caseCount = 0;
let corpus = read(join(dir, 'SCENARIOS.md'));
for (const f of readdirSync(join(dir, 'golden')).filter((f) => f.endsWith('.json'))) {
  const text = read(join(dir, 'golden', f));
  corpus += text;
  let json;
  try {
    json = JSON.parse(text);
  } catch (e) {
    problems.push(`${f}: invalid JSON (${e.message})`);
    continue;
  }
  const cases = [...(json.cases ?? []), ...(json.handshake ?? [])];
  if (!cases.length) problems.push(`${f}: no cases`);
  for (const c of cases) {
    if (!c.id) problems.push(`${f}: case without id`);
    else if (ids.has(c.id)) problems.push(`${f}: duplicate id ${c.id}`);
    ids.add(c.id);
    caseCount++;
  }
}

const spec = read(join(dir, '..', 'SPEC.md'));
const frs = [...new Set(spec.match(/FR-[A-Z]+-\d+/g))];
const uncovered = frs.filter((fr) => !corpus.includes(fr));
for (const fr of uncovered) problems.push(`${fr} has no eval`);

const readme = read(join(dir, 'README.md'));
const gaps = [...new Set(corpus.match(/G-\d+/g))];
for (const g of gaps) if (!readme.includes(`| ${g} |`)) problems.push(`${g} referenced but not listed in README.md`);

const tasks = read(join(dir, '..', 'TASKS.md'));
const scenarioIds = [...read(join(dir, 'SCENARIOS.md')).matchAll(/^\| ([A-Z0-9]+(?:-[A-Z]+)?-\d+) \|/gm)].map((m) => m[1]);
const known = new Set([...ids, ...scenarioIds]);
const named = new Set();
for (const [, prefix, from, to] of tasks.matchAll(/(?<![A-Z0-9-])((?:LIVE-EM|[A-Z0-9]{2,5}))-(\d+)(?:…(\d+))?/g)) {
  if (/^(AES|SHA|UTF|ISO)$/.test(prefix)) continue;
  for (let i = +from; i <= +(to ?? from); i++) named.add(`${prefix}-${String(i).padStart(from.length, '0')}`);
}
for (const id of named) if (!known.has(id)) problems.push(`TASKS.md names ${id}, which does not exist`);
for (const id of scenarioIds) if (!named.has(id)) problems.push(`${id} is not assigned to a task in TASKS.md`);
const goldenPrefixes = new Set([...ids].map((id) => id.replace(/-\d+$/, '')));
for (const prefix of goldenPrefixes) {
  const hasStar = tasks.includes(`${prefix}-*`);
  const allNamed = [...ids].filter((id) => id.startsWith(`${prefix}-`)).every((id) => named.has(id));
  if (!hasStar && !allNamed) problems.push(`golden ${prefix}-* is not assigned to a task in TASKS.md`);
}

const scenarioRows = (read(join(dir, 'SCENARIOS.md')).match(/^\| [A-Z0-9]+-\d+ \|/gm) ?? []).length;
console.log(`${caseCount} golden cases, ${scenarioRows} scenarios, ${frs.length - uncovered.length}/${frs.length} FRs covered, ${gaps.length} spec gaps`);
if (problems.length) {
  console.error(problems.map((p) => `  ✗ ${p}`).join('\n'));
  process.exit(1);
}
