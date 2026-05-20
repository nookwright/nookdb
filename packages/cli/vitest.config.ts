import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/__tests__/**/*.test.ts'],
    testTimeout: 30_000,
    // forks pool prevents the Windows NAPI teardown crash (0xC0000005) that
    // kills the process before the coverage reporter can write its output.
    pool: 'forks',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      thresholds: { lines: 80, functions: 80, branches: 70, statements: 80 },
      exclude: ['**/__tests__/**', '**/dist/**', '**/node_modules/**'],
    },
  },
});
