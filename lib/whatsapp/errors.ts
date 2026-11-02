// §7.7: the error table, kept as data. API errors and `errors[]` in a `failed` webhook use the same classifier.

export type ErrorAction = 'pause_campaign' | 'stop_all_campaigns' | 'retry_backoff' | 'retry_after_60s' | 'retry_transient' | 'failed' | 'failed_manual_retry_after_24h' | 'failed_and_suppress' | 'unknown';
export type ErrorBanner = 'token' | 'permission' | 'quality';
/** Whether the S-08 "Retry failed" button includes the row. */
export type RetryFailed = 'never' | 'after_24h';

export type ErrorRule = {
  action: ErrorAction;
  banner?: ErrorBanner;
  max_attempts?: number;
  suppression_reason?: 'error_131050';
  retry_failed?: RetryFailed;
};

const pause = (banner?: ErrorBanner): ErrorRule => (banner ? { action: 'pause_campaign', banner } : { action: 'pause_campaign' });
const RATE_LIMIT: ErrorRule = { action: 'retry_backoff' };
const STOP_ALL: ErrorRule = { action: 'stop_all_campaigns' };
const FAILED: ErrorRule = { action: 'failed', retry_failed: 'never' };

export const ERROR_TABLE: Record<number, ErrorRule> = {
  0: pause('token'),
  190: pause('token'),
  10: pause('permission'),
  200: pause('permission'),
  4: RATE_LIMIT,
  80007: RATE_LIMIT,
  130429: RATE_LIMIT,
  131056: { action: 'retry_after_60s' },
  131026: FAILED,
  131049: { action: 'failed_manual_retry_after_24h', retry_failed: 'after_24h' },
  131050: { action: 'failed_and_suppress', suppression_reason: 'error_131050', retry_failed: 'never' },
  131047: FAILED,
  132000: pause(),
  132001: pause(),
  132015: pause('quality'),
  132016: pause('quality'),
  131031: STOP_ALL,
  368: STOP_ALL,
};

const TRANSIENT: ErrorRule = { action: 'retry_transient', max_attempts: 3 };

export function classifyError({ code, http_status, network_error }: { code?: number; http_status?: number; network_error?: string }): ErrorRule {
  if (code !== undefined && ERROR_TABLE[code]) return ERROR_TABLE[code];
  if (network_error) {
    // G-06 and §8.3: only an error known to have happened before sending may be retried. Anything else might have reached Meta.
    return network_error.endsWith('_BEFORE_REQUEST_SENT') ? TRANSIENT : { action: 'unknown' };
  }
  if (http_status !== undefined && http_status >= 500) return TRANSIENT;
  return FAILED; // G-07: an unlisted code is failed, not retried or paused.
}

const DAY = 24 * 60 * 60 * 1000;

export function isRetryableByRetryFailed(code: number, failedAt: Date | null, now: Date): boolean {
  if (ERROR_TABLE[code]?.retry_failed !== 'after_24h') return false;
  return failedAt !== null && failedAt.getTime() < now.getTime() - DAY;
}

export type GraphError = { code?: number; error_subcode?: number; title?: string; message?: string; error_data?: { details?: string }; fbtrace_id?: string };

/** The fields every failure stores, as the text columns hold them. API errors carry `message`; webhook errors also carry `title`. */
export function failureFields(error: GraphError) {
  return {
    error_code: error.code === undefined ? null : String(error.code),
    error_subcode: error.error_subcode === undefined ? null : String(error.error_subcode),
    error_title: error.title ?? error.message ?? null,
    error_detail: error.error_data?.details ?? null,
    fbtrace_id: error.fbtrace_id ?? null,
  };
}
