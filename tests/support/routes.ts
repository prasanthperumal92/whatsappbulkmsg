import { readdirSync } from 'node:fs';
import path from 'node:path';

const API_ROOT = path.join(process.cwd(), 'app', 'api');
export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const;

/** Every route file on disk, so a new route is covered without touching any test. */
export function discoverApiRoutes(): { path: string; file: string }[] {
  return (readdirSync(API_ROOT, { recursive: true }) as string[])
    .filter((f) => path.basename(f) === 'route.ts')
    .map((f) => {
      const dir = path.dirname(f).split(path.sep).join('/');
      return { path: `/api/${dir}`, file: path.join(API_ROOT, f) };
    })
    .sort((a, b) => a.path.localeCompare(b.path));
}

/** Fills dynamic segments so a handler can be invoked directly. */
export function routeArgs(routePath: string) {
  const params = Object.fromEntries([...routePath.matchAll(/\[\.{0,3}([^\]]+)\]/g)].map((m) => [m[1]!, 'test-id']));
  return { params: Promise.resolve(params) };
}

export function request(routePath: string, method: string, init: { body?: unknown; headers?: Record<string, string> } = {}) {
  return new Request(`http://localhost${routePath.replace(/\[[^\]]+\]/g, 'test-id')}`, {
    method,
    headers: { 'content-type': 'application/json', ...init.headers },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}
