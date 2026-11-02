import type { VercelConfig } from '@vercel/config/v1';

// §3.1: functions run in Mumbai, next to the database and Blob stores.
// Cron jobs (§10) are added by the tasks that build them (T2.10, T5.13, T8.9).
export const config: VercelConfig = {
  framework: 'nextjs',
  regions: ['bom1'],
  // §3.1: migrations are a deploy step. See docs/migrations.md.
  buildCommand: 'npm run db:migrate && npm run build',
  crons: [
    { path: '/api/cron/snapshot-contacts', schedule: '0 * * * *' },
    { path: '/api/cron/cleanup', schedule: '30 20 * * *' }, // 02:00 IST
  ],
};
