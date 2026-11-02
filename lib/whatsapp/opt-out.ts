// §7.8 inbound opt-outs. Whole-message match, case-insensitive and trimmed. Trailing punctuation and emoji are
// ignored (G-08) and media captions aren't read (G-09). This only decides; the suppression service acts on it.

export type InboundMessage = {
  type: string;
  body?: string;
  payload?: string;
  text?: string;
  button_reply_title?: string;
  caption?: string;
  from?: string | null;
  from_user_id?: string | null;
};

export type OptOutDecision = {
  suppress: boolean;
  reason: 'stop_keyword' | 'button' | null;
  /** E.164, from the webhook or the identity table. */
  phone: string | null;
  /** Set when no phone is known yet: suppress the BSUID, and the phone once it's mapped (§7.8). */
  bsuid: string | null;
};

const STOP_BUTTON = 'STOP PROMOTIONS';
const TRAILING = /[\s\p{P}\p{S}\p{Emoji_Presentation}\p{Extended_Pictographic}\p{Emoji_Modifier}‍️]+$/u;

const normalise = (text: string | undefined) => (text ?? '').trim().replace(TRAILING, '').replace(/\s+/g, ' ').toUpperCase();

function reasonFor(message: InboundMessage, keywords: string[]): OptOutDecision['reason'] {
  const matches = (text: string | undefined, allowed: string[]) => {
    const value = normalise(text);
    return value !== '' && allowed.includes(value);
  };
  const configured = keywords.map((k) => normalise(k));
  if (message.type === 'text') return matches(message.body, configured) ? 'stop_keyword' : null;
  const buttonWords = [...configured, STOP_BUTTON];
  if (message.type === 'button') return matches(message.payload, buttonWords) || matches(message.text, buttonWords) ? 'button' : null;
  if (message.type === 'interactive') return matches(message.button_reply_title, buttonWords) ? 'button' : null;
  return null;
}

export function detectOptOut(message: InboundMessage, { keywords, identityMapping = {} }: { keywords: string[]; identityMapping?: Record<string, string> }): OptOutDecision {
  const reason = reasonFor(message, keywords);
  if (!reason) return { suppress: false, reason: null, phone: null, bsuid: null };
  const bsuid = message.from_user_id ?? null;
  const phone = message.from ? `+${message.from.replace(/^\+/, '')}` : (bsuid && identityMapping[bsuid]) || null;
  return { suppress: true, reason, phone, bsuid: phone ? null : bsuid };
}
