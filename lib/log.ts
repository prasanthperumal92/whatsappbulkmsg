// Structured logger (§11). Secrets are redacted and phones and emails masked before anything is written,
// so call sites can't leak them by accident. `sanitize` is also used for audit details.

const SENSITIVE_KEY = /token|secret|password|passwd|authorization|api[-_]?key|private[-_]?key|encryption[-_]?key|cookie|credential|signature|connection[-_]?string|database[-_]?url/i;
const PHONE_KEY = /phone|mobile|msisdn|wa_to/i;
const REDACTED = '[REDACTED]';

const maskDigits = (digits: string, prefix: string) => {
  if (digits.length < 7) return `${prefix}${'*'.repeat(digits.length)}`;
  return `${prefix}${digits.slice(0, 2)}${'*'.repeat(digits.length - 6)}${digits.slice(-4)}`;
};

function maskPhoneField(value: string) {
  const digits = value.replace(/\D/g, '');
  return maskDigits(digits, value.trim().startsWith('+') ? '+' : '');
}

const RULES: [RegExp, string | ((match: string) => string)][] = [
  [/\b(postgres(?:ql)?:\/\/)[^@\s/]+@/gi, `$1${REDACTED}@`],
  [/\bBearer\s+[^\s"',]+/gi, `Bearer ${REDACTED}`],
  [/\bre_[A-Za-z0-9_]{6,}/g, REDACTED],
  [/\bwhsec_[A-Za-z0-9+/=_-]+/g, REDACTED],
  [/\bsk_(?:test|live)_[A-Za-z0-9]+/g, REDACTED],
  [/\bEAA[A-Za-z0-9]{10,}/g, REDACTED],
  [/([A-Za-z0-9])[A-Za-z0-9._%+'-]*@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})/g, '$1••••@$2'],
  [/\+\d[\d\s().-]{5,18}\d/g, (m) => maskDigits(m.replace(/\D/g, ''), '+')],
  [/(?<![\w.:-])\d{10,15}(?![\w.:-])/g, (m) => maskDigits(m, '')],
];

export function scrubString(value: string): string {
  let out = value;
  for (const [pattern, replacement] of RULES) {
    out = out.replace(pattern, replacement as string);
  }
  return out;
}

export function sanitize(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') return scrubString(value);
  if (value === null || typeof value !== 'object') return typeof value === 'bigint' ? value.toString() : value;
  if (value instanceof Date) return value.toISOString();
  if (depth > 8) return '[Truncated]';
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  if (value instanceof Error) {
    return sanitize({ name: value.name, message: value.message, stack: value.stack, cause: value.cause }, depth + 1, seen);
  }
  if (Array.isArray(value)) return value.map((v) => sanitize(v, depth + 1, seen));
  return Object.fromEntries(
    Object.entries(value).map(([k, v]) => {
      if (SENSITIVE_KEY.test(k)) return [k, REDACTED];
      // A raw CSV value such as "098765 43210" doesn't look like a phone to the text patterns.
      if (PHONE_KEY.test(k) && typeof v === 'string') return [k, maskPhoneField(v)];
      return [k, sanitize(v, depth + 1, seen)];
    }),
  );
}

type Level = 'debug' | 'info' | 'warn' | 'error';
type Sink = (line: string, level: Level) => void;

const defaultSink: Sink = (line, level) => {
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
};

export function createLogger(sink: Sink = defaultSink) {
  const write = (level: Level, message: string, fields?: Record<string, unknown>) => {
    const entry = { level, at: new Date().toISOString(), message: scrubString(message), ...(sanitize(fields ?? {}) as object) };
    sink(JSON.stringify(entry), level);
  };
  return {
    debug: (m: string, f?: Record<string, unknown>) => write('debug', m, f),
    info: (m: string, f?: Record<string, unknown>) => write('info', m, f),
    warn: (m: string, f?: Record<string, unknown>) => write('warn', m, f),
    error: (m: string, f?: Record<string, unknown>) => write('error', m, f),
  };
}

export const log = createLogger();
