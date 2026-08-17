import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    testTimeout: 10000,
    // Bridge keeps its tests under tests/ (not src/). Without this config, vitest
    // walks up to the root config (include: src/**) and finds no test files.
    include: ['tests/**/*.{test,spec}.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: [
        // Daemon entrypoint - a top-level side-effect script (parses env,
        // wires the SSE client, starts the work queue) analogous to the
        // gateway's src/index.ts before its module-is-main seam. Out of
        // scope for this coverage gate (task bfa8e4b6), matching how the
        // root config excludes src/cli.ts for the same reason.
        'src/index.ts',
      ],
      // Thresholds set ~5 points below the measured baseline (vitest run
      // --coverage on 2026-08-17 produced:
      //   stmts 63.42 / branches 68.75 / funcs 72.72 / lines 64.77
      // sse-client.ts is largely untested beyond parseSseFrame (pre-existing
      // gap, out of scope for this pass) and pulls the aggregate down;
      // config.ts and claude-runner.ts get their own tighter per-file floors
      // since this task added their coverage (config.ts measured 100% across
      // the board; claude-runner.ts measured stmts 95.91 / branches 83.33 /
      // funcs 80 / lines 97.72 - the one uncovered branch is the 5s
      // SIGKILL escalation after an ignored SIGTERM, a defense-in-depth path
      // not exercised here).
      thresholds: {
        statements: 58,
        branches: 63,
        functions: 67,
        lines: 59,
        'src/config.ts': { statements: 95, branches: 95, functions: 95, lines: 95 },
        'src/claude-runner.ts': { statements: 90, branches: 75, functions: 72, lines: 90 },
      },
    },
  },
});
