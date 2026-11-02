#!/usr/bin/env node
// Runs the production build with the REAL Clerk SDK and placeholder keys, then checks what each kind of
// caller gets. Local browser tests swap Clerk for a stand-in, so only this can catch a real-SDK mistake:
// for example, Clerk redirecting a webhook, which would otherwise surface only at go-live.
//
//   npm run build && npm run test:proxy     (needs the Clerk keys from CI's build step in the environment)

import { spawn } from 'node:child_process';
import { join } from 'node:path';

const port = 3190;
const base = `http://localhost:${port}`;
const cronSecret = 'smoke-secret';
const next = join(process.cwd(), 'node_modules', 'next', 'dist', 'bin', 'next');

const server = spawn(process.execPath, [next, 'start', '-p', String(port)], {
  stdio: 'ignore',
  env: { ...process.env, CRON_SECRET: cronSecret, DATABASE_URL: 'postgres://nobody:nope@127.0.0.1:1/none' },
});

const checks = [
  // Protected APIs answer 401 as JSON, and never redirect.
  ['GET', '/api/team', {}, 401],
  ['POST', '/api/team', {}, 401],
  ['GET', '/api/settings', {}, 401],
  ['GET', '/api/audit', {}, 401],
  ['GET', '/api/status', {}, 401],
  // Lookalikes of the exempt prefixes get no exemption.
  ['GET', '/api/webhooksfoo', {}, 401],
  ['GET', '/api/cronx', {}, 401],
  // Exempt prefixes reach the route layer with no session. No such webhook exists yet, hence 404, not a redirect.
  ['POST', '/api/webhooks/none', {}, 404],
  ['GET', '/u/none', {}, 404],
  // SEC-03 through the real proxy.
  ['GET', '/api/cron/ping', {}, 401],
  ['GET', '/api/cron/ping', { authorization: 'Bearer wrong' }, 401],
  ['GET', '/api/cron/ping', { authorization: `Bearer ${cronSecret}` }, 200],
  // Pages go to the app's own sign-in page, not Clerk's hosted one.
  ['GET', '/contacts', {}, 307, '/sign-in'],
  ['GET', '/sign-up', {}, 307, '/sign-in'],
  ['GET', '/not-allowed', {}, 307, '/sign-in'],
  ['GET', '/sign-in', {}, 200],
];

async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    try {
      await fetch(`${base}/sign-in`, { redirect: 'manual' });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error('The server did not start');
}

let failed = 0;
try {
  await waitForServer();
  for (const [method, path, headers, status, location] of checks) {
    const res = await fetch(base + path, { method, headers, redirect: 'manual' });
    const target = res.headers.get('location') ?? '';
    const locationOk = !location || new URL(target, base).origin === base && new URL(target, base).pathname === location;
    const ok = res.status === status && locationOk;
    if (!ok) failed++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${method} ${path} -> ${res.status}${target ? ` ${target.slice(0, 70)}` : ''}${ok ? '' : ` (wanted ${status}${location ? ` ${location}` : ''})`}`);
  }
} finally {
  server.kill();
}
if (failed) process.exit(1);
