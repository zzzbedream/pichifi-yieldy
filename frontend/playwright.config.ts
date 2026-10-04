import { defineConfig, devices } from '@playwright/test';

// Landing E2E against a deployed dashboard: BASE_URL=https://pichifi-yieldy.vercel.app pnpm e2e
// Files use *.e2e.ts so vitest (unit tests) never picks them up.
export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.e2e.ts',
  timeout: 60_000,
  retries: 1,
  reporter: [['list']],
  outputDir: 'e2e/.results',
  use: { baseURL: process.env.BASE_URL ?? 'https://pichifi-yieldy.vercel.app', trace: 'retain-on-failure' },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
    { name: 'mobile', use: { ...devices['Pixel 7'] } },
  ],
});
