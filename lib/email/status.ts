// §8.1 and §7A.8: webhook precedence for email. Forward only, and pure, so the ES-* goldens pin it.

export type EmailStatus = 'pending' | 'claimed' | 'sending' | 'retry_wait' | 'unknown' | 'skipped' | 'accepted' | 'sent' | 'delayed' | 'delivered' | 'opened' | 'clicked' | 'bounced' | 'failed' | 'complained';
export type EmailEvent = { type: string; bounce_type?: string | null };
export type SuppressionReason = 'hard_bounce' | 'complaint' | 'resend_suppressed';

export type EmailStatusResult = {
  status: EmailStatus;
  suppress: SuppressionReason | null;
  /** The row was never sent, so this event can't belong to it. */
  unmatched: boolean;
};

const RANK: Partial<Record<EmailStatus, number>> = { accepted: 1, sent: 2, delayed: 3, delivered: 4, opened: 5, clicked: 6 };
const NEVER_SENT: EmailStatus[] = ['pending', 'claimed', 'retry_wait', 'skipped'];
const FORWARD: Record<string, EmailStatus> = {
  engine_accepted: 'accepted',
  'email.sent': 'sent',
  'email.delivery_delayed': 'delayed',
  'email.delivered': 'delivered',
  'email.opened': 'opened',
  'email.clicked': 'clicked',
};

function target({ type, bounce_type }: EmailEvent): { status: EmailStatus; suppress: SuppressionReason | null } | null {
  if (FORWARD[type]) return { status: FORWARD[type], suppress: null };
  switch (type) {
    case 'email.bounced':
      return bounce_type === 'Permanent' ? { status: 'bounced', suppress: 'hard_bounce' } : { status: 'failed', suppress: null };
    case 'email.complained':
      return { status: 'complained', suppress: 'complaint' };
    case 'email.failed':
      return { status: 'failed', suppress: null };
    case 'email.suppressed':
      return { status: 'failed', suppress: 'resend_suppressed' };
    default:
      return null; // email.scheduled, email.received and anything new: stored and ignored.
  }
}

function next(current: EmailStatus, incoming: EmailStatus): EmailStatus {
  if (current === 'complained') return current;
  if (incoming === 'complained' || current === 'sending' || current === 'unknown') return incoming;
  if (current === 'bounced' || current === 'failed') return current;
  if (incoming === 'bounced') return RANK[current]! <= RANK.delivered! ? incoming : current;
  if (incoming === 'failed') return RANK[current]! <= RANK.delayed! ? incoming : current;
  return RANK[incoming]! > RANK[current]! ? incoming : current;
}

export function reduceEmailStatus(current: EmailStatus, event: EmailEvent): EmailStatusResult {
  if (NEVER_SENT.includes(current)) return { status: current, suppress: null, unmatched: true };
  const to = target(event);
  if (!to) return { status: current, suppress: null, unmatched: false };
  return { status: next(current, to.status), suppress: to.suppress, unmatched: false };
}
