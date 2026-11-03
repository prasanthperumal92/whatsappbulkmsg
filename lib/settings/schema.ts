import { z } from 'zod';

// Non-secret settings with their §5.2 defaults, one `settings` row per section.
// Sections are strict: an unknown key is refused, so secrets can't land here by accident.

const consent = z.enum(['opted_in', 'unknown', 'opted_out']);
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const sendWindow = z.strictObject({ start: time, end: time });
const country = z.string().regex(/^[A-Z]{2}$/);
const nullableUrl = z.url().nullable();

const EU_EEA = [
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT',
  'RO', 'SK', 'SI', 'ES', 'SE', 'IS', 'LI', 'NO',
];

export const settingsSchema = {
  whatsapp: z.strictObject({
    provider: z.enum(['graph', 'mock']).default('mock'), // local dev only; §3.5 fixes it elsewhere
    graphApiVersion: z.string().regex(/^v\d+\.\d+$/).default('v26.0'),
  }),
  whatsappSending: z.strictObject({
    messagesPerSecond: z.number().positive().max(80).default(20),
    frequencyCapDays: z.number().int().min(0).default(7),
    sendWindow: sendWindow.default({ start: '09:00', end: '20:00' }),
    testPhones: z.array(z.string()).default([]),
    messagingLimitTier: z.string().nullable().default(null),
    sendEndpoint: z.enum(['/messages', '/marketing_messages']).default('/messages'),
    circuitBreakerFailurePercent: z.number().min(0).max(100).default(25),
    priceTable: z
      .strictObject({ default: z.number().min(0).nullable(), byCountry: z.record(country, z.number().min(0)) })
      .default({ default: null, byCountry: {} }),
    restrictedCountries: z.array(country).default(['US']),
  }),
  email: z.strictObject({
    provider: z.enum(['resend', 'mock']).default('mock'), // local dev only; §3.5 fixes it elsewhere
    domain: z.string().nullable().default(null),
    fromName: z.string().nullable().default(null),
    fromAddress: z.email().nullable().default(null),
    replyTo: z.email().nullable().default(null),
    postalAddress: z.string().max(500).nullable().default(null),
    signature: z.string().max(2000).nullable().default(null),
    unsubscribeWording: z.string().nullable().default(null),
  }),
  emailSending: z.strictObject({
    batchRequestsPerSecond: z.number().positive().max(10).default(2),
    dailyCap: z.number().int().positive().default(100),
    monthlyCap: z.number().int().positive().default(3000),
    hourlyCap: z.number().int().positive().default(5000),
    stagedSending: z.boolean().default(true),
    newDomainRamp: z.boolean().default(true),
    frequencyCapDays: z.number().int().min(0).default(7),
    sendWindow: sendWindow.default({ start: '09:00', end: '20:00' }),
    testEmails: z.array(z.email()).default([]),
    bounceRatePercent: z.number().min(0).max(100).default(5),
    complaintRatePercent: z.number().min(0).max(100).default(0.3),
    pricePer1000: z.number().min(0).nullable().default(null),
  }),
  import: z.strictObject({
    defaultCountry: country.default('IN'),
    fallbackTimeZone: z.string().default('Asia/Kolkata'),
    defaultWhatsappOptIn: consent.default('unknown'),
    defaultEmailOptIn: consent.default('unknown'),
    existingContactPolicy: z.enum(['skip', 'fill_empty', 'overwrite']).default('fill_empty'),
    maxFileSizeMb: z.number().positive().default(50),
  }),
  data: z.strictObject({
    optOutKeywords: z.array(z.string().min(1)).default(['STOP', 'UNSUBSCRIBE', 'STOP PROMOTIONS']),
    messageRetentionMonths: z.number().int().positive().default(24), // §12A.2
    auditRetentionMonths: z.number().int().positive().default(24), // §12A.2
  }),
  audience: z.strictObject({
    unknownConsentLimit: z.number().int().min(0).default(500),
    strictConsentCountries: z.array(country).default([...EU_EEA, 'GB', 'GG', 'JE', 'IM', 'CA']),
    privacyNoticeUrl: nullableUrl.default(null),
  }),
} as const;

export type SettingsSection = keyof typeof settingsSchema;
export const SETTINGS_SECTIONS = Object.keys(settingsSchema) as SettingsSection[];
export type Settings = { [K in SettingsSection]: z.output<(typeof settingsSchema)[K]> };

export function defaultSettings(): Settings {
  return Object.fromEntries(SETTINGS_SECTIONS.map((s) => [s, settingsSchema[s].parse({})])) as Settings;
}
