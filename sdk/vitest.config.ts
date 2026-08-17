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
      // --coverage on 2026-08-17 produced:
      //   stmts 78.7 / branches 70.37 / funcs 89.39 / lines 78.43
      // http.ts (the fetch/AbortController request internals) is out of
      // scope for this task - only its consumers (the resources/* wrappers,
      // added this pass) are covered - and pulls the aggregate down.
      thresholds: {
        statements: 73,
        branches: 65,
        functions: 84,
        lines: 73,
      },
    },
  },
});
