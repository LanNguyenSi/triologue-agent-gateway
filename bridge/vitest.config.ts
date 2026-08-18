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
      // --coverage on 2026-08-18, after closing the SIGKILL liveness-guard
      // test gaps for claude-runner.ts — pinning the killTimer's clearTimeout
      // cancellation (previously masked by the 'exit' listener) and adding a
      // fake-timer test for the `exited === true` suppression branch —
      // produced:
      //   stmts 65.16 / branches 71.25 / funcs 76.47 / lines 66.04
      // (previous baseline, 2026-08-18 earlier same day, before this pass:
      //   stmts 65.16 / branches 70 / funcs 76.47 / lines 66.04)
      // sse-client.ts is largely untested beyond parseSseFrame (pre-existing
      // gap, out of scope for this pass) and pulls the aggregate down;
      // config.ts and claude-runner.ts get their own tighter per-file floors.
      // claude-runner.ts now measures stmts 100 / branches 100 / funcs 90.9
      // / lines 100 - both sides of the killTimer's `if (!exited)` guard
      // (escalate vs. suppress) are now exercised by fake-timer tests; the
      // remaining function-coverage gap is the no-op `.catch(() => {})`
      // callback on the `finally` block's temp-dir `rm()` cleanup (line
      // 228), unrelated to the killTimer guard.
      thresholds: {
        statements: 59,
        branches: 65,
        functions: 70,
        lines: 60,
        'src/config.ts': { statements: 95, branches: 95, functions: 95, lines: 95 },
        'src/claude-runner.ts': { statements: 95, branches: 95, functions: 85, lines: 95 },
      },
    },
  },
});
