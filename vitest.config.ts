import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    exclude: ['tests/**/e2e/**', 'node_modules/**'],
    environment: 'node',
    globals: true,
    passWithNoTests: false,
    // CI runners (Windows especially) do real fsyncs on every SQLite commit and are
    // far slower than a laptop, so the long property tests get more time there.
    testTimeout: process.env.CI ? 120000 : 20000,
  },
});
