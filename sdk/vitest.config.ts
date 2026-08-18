import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    testTimeout: 10000,
    // sdk keeps its tests co-located with the source under src/.
    include: ['src/**/*.{test,spec}.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: [
        // Test files themselves
        'src/**/*.test.ts',
        // Barrel re-export - no executable statements of its own.
        'src/index.ts',
        // Type-only declarations file - no executable statements.
        'src/types.ts',
      ],
      // Thresholds set ~5 points below the measured baseline (vitest run
      // --coverage on 2026-08-18, after adding direct fetch/AbortController
      // transport tests for http.ts - timeout, non-2xx error mapping,
      // AbortSignal, the 204 path, and header/body construction - produced:
      //   stmts 100 / branches 100 / funcs 100 / lines 100
      // (previous baseline, 2026-08-17, before http.ts had its own tests:
      //   stmts 78.7 / branches 70.37 / funcs 89.39 / lines 78.43)
      thresholds: {
        statements: 95,
        branches: 95,
        functions: 95,
        lines: 95,
      },
    },
  },
});
