import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    testTimeout: 10000,
    // Restrict to source tests; default glob also matches dist/**/*.test.js after build.
    include: ['src/**/*.{test,spec}.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: [
        // Test files themselves
        'src/__tests__/**',
        // CLI — separate tool, not in scope for this coverage gate
        'src/cli.ts',
        // Types file has no executable statements
        'src/types.ts',
      ],
      // Thresholds set ~5 points below measured baseline (vitest run --coverage
      // with include:src/**/*.ts on 2026-06-29 produced:
      //   stmts 32.59 / branches 31.36 / funcs 23.49 / lines 32.96
      // NOTE: several out-of-scope files (triologue-bridge, openclaw-bridge,
      // read-tracker) are mocked away by tests so they show 0% coverage —
      // this intentionally pulls the numbers down. Raise thresholds as more
      // coverage is added in follow-up work.
      thresholds: {
        statements: 28,
        branches: 26,
        functions: 18,
        lines: 28,
      },
    },
  },
});
