import { defineConfig, devices } from '@playwright/test';

const port = Number(process.env.E2E_PORT ?? 3100);

// Local checks with a fake Clerk module. SEC-01 and HN-03 still need a preview deployment with real Clerk.
export default defineConfig({
  testDir: './tests/e2e-local',
  use: { baseURL: `http://localhost:${port}` },
  workers: 1,
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: { command: 'npx tsx scripts/e2e-local-server.ts', url: `http://localhost:${port}/sign-in`, timeout: 120_000, reuseExistingServer: false },
});
