// §7.8 and §8.1: webhook status precedence. Forward only; `failed` overrides accepted and sent; `unknown` and
// `sending` rows are resolved by anything. An out-of-order status still records its timestamp.

export type MessageStatus = 'pending' | 'claimed' | 'sending' | 'retry_wait' | 'unknown' | 'accepted' | 'sent' | 'delivered' | 'read' | 'failed' | 'skipped';
/** `engine_accepted` is the send step saving its own result, possibly after a webhook has already arrived. */
export type IncomingStatus = 'engine_accepted' | 'sent' | 'delivered' | 'read' | 'failed';

export type StatusRow = {
  status: MessageStatus;
  wamid?: string | null;
  accepted_at?: Date | null;
  sent_at?: Date | null;
  delivered_at?: Date | null;
  read_at?: Date | null;
  failed_at?: Date | null;
};

export type StatusPatch = Partial<Omit<StatusRow, 'status'>> & { status?: MessageStatus };

export type StatusResult = {
  status: MessageStatus;
  /** Only the columns that change. */
  patch: StatusPatch;
  /** The row was never sent, so this status can't belong to it: log it as unmatched (ST-16). */
  unmatched: boolean;
  /** True once only, on the move to `failed`, so a duplicate webhook can't repeat a suppression or pause (§7.7). */
  runFailureAction: boolean;
};

const RANK: Partial<Record<MessageStatus, number>> = { accepted: 1, sent: 2, delivered: 3, read: 4 };
const NEVER_SENT: MessageStatus[] = ['pending', 'claimed', 'retry_wait', 'skipped'];
const TIMESTAMP = { engine_accepted: 'accepted_at', sent: 'sent_at', delivered: 'delivered_at', read: 'read_at', failed: 'failed_at' } as const;

function nextStatus(current: MessageStatus, incoming: IncomingStatus): MessageStatus {
  const target: MessageStatus = incoming === 'engine_accepted' ? 'accepted' : incoming;
  if (current === 'failed') return current;
  if (current === 'sending' || current === 'unknown') return target;
  if (target === 'failed') return current === 'accepted' || current === 'sent' ? 'failed' : current;
  return RANK[target]! > RANK[current]! ? target : current;
}

export function reduceStatus(row: StatusRow, event: { status: IncomingStatus; at: Date; wamid?: string | null }): StatusResult {
  if (NEVER_SENT.includes(row.status)) return { status: row.status, patch: {}, unmatched: true, runFailureAction: false };

  const status = nextStatus(row.status, event.status);
  const movedToFailed = status === 'failed' && row.status !== 'failed';
  // A failure the row ignored didn't happen to it, so it leaves no failed_at behind.
  const ignoredFailure = event.status === 'failed' && status !== 'failed';

  const patch: StatusPatch = {};
  if (status !== row.status) patch.status = status;
  const column = TIMESTAMP[event.status];
  if (!ignoredFailure && !row[column]) patch[column] = event.at;
  if (event.wamid && !row.wamid && !ignoredFailure) patch.wamid = event.wamid;

  return { status, patch, unmatched: false, runFailureAction: movedToFailed };
}
