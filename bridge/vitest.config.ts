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
      // --coverage on 2026-08-18, after adding the fake-timer SIGKILL-
      // escalation test (M8) for claude-runner.ts, produced:
      //   stmts 64.57 / branches 70 / funcs 75.75 / lines 65.4
      // (previous baseline, 2026-08-17, before M8:
      //   stmts 63.42 / branches 68.75 / funcs 72.72 / lines 64.77)
      // sse-client.ts is largely untested beyond parseSseFrame (pre-existing
      // gap, out of scope for this pass) and pulls the aggregate down;
      // config.ts and claude-runner.ts get their own tighter per-file floors.
      // claude-runner.ts now measures stmts 100 / branches 91.66 / funcs 90
      // / lines 100 - the one still-uncovered branch is the *other* side of
      // the killTimer's `if (!child.killed)` check (the case where the
      // SIGTERM kill() call already reported `killed`, so SIGKILL is
      // skipped), which no test drives all the way to that timer firing.
      thresholds: {
        statements: 59,
        branches: 65,
        functions: 70,
        lines: 60,
        'src/config.ts': { statements: 95, branches: 95, functions: 95, lines: 95 },
        'src/claude-runner.ts': { statements: 95, branches: 85, functions: 85, lines: 95 },
      },
    },
  },
});
