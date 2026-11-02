import { timingSafeEqual, createHash } from 'node:crypto';
import { getDb, schema, type Db, type Tx } from '@/lib/db';
import { getSessionState, type TeamMember } from '@/lib/auth/session';
import { log, sanitize } from '@/lib/log';
import { ApiError, errorResponse } from './errors';

// Every route handler is built with one of these wrappers. The route-table test
// (tests/integration/route-table.test.ts) reads the brand and fails on any handler
// that bypasses them, so a new route can't be left unauthenticated or unaudited.

export type RouteKind = 'session' | 'audited' | 'cron' | 'webhook';
export const ROUTE_KIND = Symbol.for('app.route-kind');

type RouteArgs = { params: Promise<Record<string, string | string[]>> };
type Handler = ((req: Request, args: RouteArgs) => Promise<Response>) & { [ROUTE_KIND]?: RouteKind };

function brand(kind: RouteKind, handler: Handler): Handler {
  handler[ROUTE_KIND] = kind;
  return handler;
}

function handleError(err: unknown, req: Request): Response {
  if (err instanceof ApiError) return errorResponse(err.status, err.code, err.message);
  log.error('Unhandled route error', { method: req.method, path: new URL(req.url).pathname, err });
  return errorResponse(500, 'internal_error', 'Something went wrong');
}

async function requireMember(db: Db): Promise<TeamMember> {
  const session = await getSessionState(db);
  if (session.state === 'anonymous') throw new ApiError(401, 'unauthenticated', 'Sign in required');
  if (session.state === 'forbidden') throw new ApiError(403, 'not_on_allowlist', 'This account is not on the team allowlist');
  return session.user;
}

export type SessionContext = { user: TeamMember; db: Db; params: Record<string, string | string[]> };

/** Read-only route: needs a session from an allowlisted user. */
export function withSession(handler: (req: Request, ctx: SessionContext) => Promise<Response>) {
  return brand('session', async (req, args) => {
    try {
      const db = getDb();
      const user = await requireMember(db);
      return await handler(req, { user, db, params: args?.params ? await args.params : {} });
    } catch (err) {
      return handleError(err, req);
    }
  });
}

export type AuditEntry = { entityId?: string | null; channel?: 'whatsapp' | 'email' | 'both' | null; details?: Record<string, unknown> };
export type AuditedContext = {
  user: TeamMember;
  tx: Tx;
  params: Record<string, string | string[]>;
  /** Sets what the audit row records. Details are scrubbed; secrets are never stored. */
  audit: (entry: AuditEntry) => void;
};

class RollbackWith extends Error {
  constructor(readonly response: Response) {
    super('rollback');
  }
}

export async function writeAudit(
  tx: Tx,
  actor: { id: string; email?: string | null },
  action: string,
  entity: string,
  entry: AuditEntry = {},
) {
  const details = sanitize({ ...entry.details, ...(entry.channel ? { channel: entry.channel } : {}) });
  await tx.insert(schema.auditLog).values({
    userId: actor.id,
    userEmail: actor.email ?? null,
    action,
    entity,
    entityId: entry.entityId ?? null,
    detailsJson: details as Record<string, unknown>,
  });
}

/**
 * State-changing route. The handler and its one audit row share a transaction (§4.2):
 * an error or a non-2xx response rolls back the change, and no audit row remains.
 */
export function withAudit(meta: { action: string; entity: string }, handler: (req: Request, ctx: AuditedContext) => Promise<Response>) {
  return brand('audited', async (req, args) => {
    try {
      const db = getDb();
      const user = await requireMember(db);
      const params = args?.params ? await args.params : {};
      return await db.transaction(async (tx) => {
        let entry: AuditEntry = {};
        const response = await handler(req, { user, tx, params, audit: (e) => void (entry = e) });
        if (!response.ok) throw new RollbackWith(response);
        await writeAudit(tx, user, meta.action, meta.entity, entry);
        return response;
      });
    } catch (err) {
      if (err instanceof RollbackWith) return err.response;
      return handleError(err, req);
    }
  });
}

/** Public route that must verify its own signature. Used by T5.5 and T8.4. */
export function withWebhook(handler: (req: Request) => Promise<Response>) {
  return brand('webhook', async (req) => {
    try {
      return await handler(req);
    } catch (err) {
      return handleError(err, req);
    }
  });
}

function safeEqual(a: string, b: string) {
  const digest = (s: string) => createHash('sha256').update(s).digest();
  return timingSafeEqual(digest(a), digest(b));
}

/** True only for `Authorization: Bearer $CRON_SECRET`. An unset secret refuses everything. */
export function requireCron(req: Request, secret = process.env.CRON_SECRET): boolean {
  if (!secret) return false;
  return safeEqual(req.headers.get('authorization') ?? '', `Bearer ${secret}`);
}

export function withCron(handler: (req: Request) => Promise<Response>) {
  return brand('cron', async (req) => {
    if (!requireCron(req)) return errorResponse(401, 'unauthorized', 'Invalid cron secret');
    try {
      return await handler(req);
    } catch (err) {
      return handleError(err, req);
    }
  });
}
