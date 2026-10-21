import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    exclude: ['tests/**/e2e/**', 'node_modules/**'],
    environment: 'node',
    globals: true,
    passWithNoTests: false,
    testTimeout: 20000,
  },
});
