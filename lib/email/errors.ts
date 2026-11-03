// §7A.7: the Resend error table, kept as data, as §7.7 does for WhatsApp.

export type EmailErrorAction =
  /** Nothing else will work until a person fixes something. */
  | 'stop'
  /** The whole batch was refused and nothing was sent, so send its rows one at a time. */
  | 'split'
  /** Safe to repeat with the same idempotency key. */
  | 'retry';

export const EMAIL_ERROR_TABLE: Record<string, EmailErrorAction> = {
  missing_api_key: 'stop',
  invalid_api_key: 'stop',
  restricted_api_key: 'stop',
  invalid_access: 'stop',
  security_error: 'stop',
  invalid_from_address: 'stop',
  invalid_idempotent_request: 'stop', // Rendering isn't deterministic: never send under a new key automatically.
  daily_quota_exceeded: 'stop',
  monthly_quota_exceeded: 'stop',
  rate_limit_exceeded: 'retry',
  concurrent_idempotent_requests: 'retry',
  application_error: 'retry',
  internal_server_error: 'retry',
  validation_error: 'split',
  invalid_parameter: 'split',
  missing_required_field: 'split',
};

const SENDER_PROBLEM = /domain|from.*(address|field)/i;

export function classifyEmailError({ status, code, message }: { status: number | null; code?: string | null; message?: string | null }): EmailErrorAction {
  if (status === 401 || status === 403) return 'stop';
  const listed = code ? EMAIL_ERROR_TABLE[code] : undefined;
  if (listed === 'split' && SENDER_PROBLEM.test(message ?? '')) return 'stop'; // Every row would fail the same way.
  if (listed) return listed;
  if (status === null || status === 429 || status >= 500) return 'retry';
  if (status === 400 || status === 422) return 'split';
  return 'stop';
}
