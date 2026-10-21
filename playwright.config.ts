import { defineConfig } from '@playwright/test';

// End-to-end tests drive the built Electron app (out/main/index.js); no browser projects or web server.
export default defineConfig({
  testDir: 'tests/phase5/e2e',
  testMatch: '**/*.spec.ts',
  workers: 1,
  fullyParallel: false,
  timeout: 180_000,
  outputDir: 'test-results',
  reporter: [['list']],
  retries: 0,
});
