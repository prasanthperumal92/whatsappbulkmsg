import { z } from 'zod';
import { ApiError } from '@/lib/api/errors';
import { sendWindowState } from '@/lib/campaigns/send-window';
import type { ContactRow } from '@/lib/contacts/store';
import type { Db, Tx } from '@/lib/db';
import { selection } from '@/lib/email/audience';
import { credentialSources } from '@/lib/settings/secrets';
import { getSettings } from '@/lib/settings/store';
import { MAX_DIRECT_WHATSAPP, resolveWhatsAppAudience, tierLimit, uniqueMessagedLastDay, type WhatsAppExclusion, type WhatsAppPlan } from './audience';
import { buildSendPayload, type SendPayload, type VariableMapping } from './payload';
import { getWhatsAppProvider } from './provider';
import { VARIABLE_FIELDS } from './shared';
import { renderBody, type TemplateShape } from './template-shape';
import { loadSendableTemplate, type TemplateRow } from './templates';
import { resolveValue, type ValueSource } from '@/lib/campaigns/variables';

const fallback = z.string().max(1024).optional();
const valueSource = z.union([z.strictObject({ field: z.enum(VARIABLE_FIELDS), fallback }), z.strictObject({ static: z.string().max(1024), fallback })]);
const mediaLink = z.strictObject({ media_link: z.url({ protocol: /^https$/ }).max(2000) });
export const variableMapping = z.record(z.string().max(200), z.union([valueSource, mediaLink]));

export const whatsappRequest = z.object({
  selection,
  include_unknown: z.boolean().default(false),
  template_id: z.string().max(100).optional(),
  mapping: variableMapping.default({}),
});

export type WhatsAppPreview = {
  selected: number;
  recipients: number;
  excluded: Record<WhatsAppExclusion, number>;
  provider: 'graph' | 'mock' | null;
  /** The message as the first recipient would read it. */
  sample: string | null;
  /** Each of these blocks sending. */
  problems: string[];
  warnings: string[];
};

/** The first contact's rendered body, with a variable that has no value left visibly unfilled. */
function sampleFor(shape: TemplateShape, mapping: VariableMapping, contact: ContactRow | undefined): string | null {
  if (!contact) return null;
  return renderBody(shape.body, (name) => {
    const source = mapping[name];
    return source && !('media_id' in source) && !('media_link' in source) ? resolveValue(source as ValueSource, contact) : null;
  });
}

const placeholderId = '00000000-0000-0000-0000-000000000000';

/** A recipient missing a variable with no fallback is left out, and never sent an empty value (§5.8 step 3). */
function dropEmptyVariables(plan: WhatsAppPlan, shape: TemplateShape, mapping: VariableMapping): WhatsAppPlan {
  const recipients = plan.recipients.filter((c) => 'body' in buildSendPayload(shape.payload, mapping, { ...c, wa_to: c.wa_to! }, placeholderId));
  return { ...plan, recipients, excluded: { ...plan.excluded, empty_variable: plan.recipients.length - recipients.length } };
}

/** §5.8's checks before Send is enabled. The send route repeats them, so a stale form can't get past. */
export async function prepareWhatsAppSend(db: Db | Tx, input: z.output<typeof whatsappRequest>, now = new Date()) {
  const settings = await getSettings(db);
  const provider = await getWhatsAppProvider(db);
  let plan = await resolveWhatsAppAudience(db, input.selection, settings, input.include_unknown, now);
  const problems: string[] = [];
  if (!provider) problems.push('WhatsApp isn’t connected. Add your access token, WhatsApp Business Account ID and phone number ID in Settings → WhatsApp.');

  let template: { row: TemplateRow; shape: TemplateShape } | null = null;
  if (input.template_id) {
    try {
      template = await loadSendableTemplate(db, input.template_id);
      plan = dropEmptyVariables(plan, template.shape, input.mapping);
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
      problems.push(err.message);
    }
  } else {
    problems.push('Choose a template.');
  }

  const count = plan.recipients.length;
  if (count > MAX_DIRECT_WHATSAPP) problems.push(`A single send can reach ${MAX_DIRECT_WHATSAPP} people. Select fewer contacts, and send the rest afterwards.`);
  const limit = tierLimit(settings.whatsappSending.messagingLimitTier);
  if (limit !== null) {
    const used = await uniqueMessagedLastDay(db, now);
    if (used + count > limit) problems.push(`Meta limits this number to ${limit.toLocaleString('en-IN')} people in 24 hours, and ${used.toLocaleString('en-IN')} have been messaged already. Select fewer contacts, or send the rest tomorrow.`);
  }

  const { start, end } = settings.whatsappSending.sendWindow;
  const zones = [...new Set(plan.recipients.map((c) => c.time_zone ?? settings.import.fallbackTimeZone))];
  const open = new Set(sendWindowState({ now, zones, window: { start, end } }).openZones);
  const outside = plan.recipients.filter((c) => !open.has(c.time_zone ?? settings.import.fallbackTimeZone)).length;
  const secretSet = (await credentialSources(db)).META_APP_SECRET !== 'none';
  const warnings = [
    ...(outside ? [`It’s outside ${start}–${end} local time for ${outside} ${outside === 1 ? 'recipient' : 'recipients'}. This sends right away, so they’ll get it now.`] : []),
    ...(provider?.kind === 'graph' && !secretSet ? ['The WhatsApp webhook isn’t connected, so delivery updates won’t arrive and STOP replies won’t be recorded. Connect it in Settings before sending marketing messages.'] : []),
  ];
  return { settings, provider, plan, template, problems, warnings, sample: template ? sampleFor(template.shape, input.mapping, plan.recipients[0]) : null };
}

export function toWhatsAppPreview({ plan, provider, problems, warnings, sample }: Awaited<ReturnType<typeof prepareWhatsAppSend>>): WhatsAppPreview {
  return { selected: plan.selected, recipients: plan.recipients.length, excluded: plan.excluded, provider: provider?.kind ?? null, sample, problems, warnings };
}

