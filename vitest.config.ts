import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    testTimeout: 10000,
    // Restrict to source tests; default glob also matches dist/**/*.test.js after build.
    // examples/**/*.test.ts is a narrow addition: it lets a test for
    // examples/sse-client.ts live next to it (importing it from src/__tests__
    // fails tsc's rootDir check, since examples/ is outside "src"). examples/
    // is not part of the Docker build (only src/ is copied, see Dockerfile)
    // and is excluded from the coverage.include below, so this does not
    // affect the build or the coverage gate.
    include: ['src/**/*.{test,spec}.ts', 'examples/**/*.{test,spec}.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: [
        // Test files themselves
        'src/__tests__/**',
        // CLI: tested via spawned tsx child processes (cli.test.ts), which
        // the in-worker v8 provider cannot instrument, so including it would
        // report ~0% and drag the global gate down. A gate would need
        // NODE_V8_COVERAGE on the child.
        'src/cli.ts',
        // Types file has no executable statements
        'src/types.ts',
      ],
      // Thresholds set ~5 points below measured baseline (vitest run --coverage
      // with include:src/**/*.ts on 2026-08-17, after closing the MED/LOW
      // gaps from task bfa8e4b6, produced:
      //   stmts 59.53 / branches 47.57 / funcs 58.68 / lines 60.94
      // openclaw-bridge.ts, openclaw-inject.ts, triologue-bridge.ts,
      // metrics.ts, and read-tracker.ts are newly covered by this task and
      // get their own per-file floors below, ratcheted from their measured
      // values with headroom. byoa-mcp.ts and webhook-dispatch.ts remain
      // pre-existing gaps out of scope for this pass.
      //
      // openclaw-inject.ts re-measured 2026-08-18 after adding its
      // module-is-main entrypoint guard (mirroring index.ts's isMainModule
      // seam) plus the import-side-effect-free test: stmts 58.2 / branches
      // 30 / funcs 50 / lines 60.65 (previous baseline: stmts 57.57 /
      // branches 27.77 / funcs 50 / lines 60). The guarded CLI tail stays
      // uncovered by design, same as index.ts's main() block.
      thresholds: {
        statements: 54,
        branches: 42,
        functions: 53,
        lines: 55,
        'src/auth.ts': { statements: 72, branches: 75, functions: 62, lines: 72 },
        'src/loop-guard.ts': { statements: 100, branches: 100, functions: 100, lines: 100 },
        'src/byoa-sse.ts': { statements: 46, branches: 38, functions: 38, lines: 46 },
        'src/index.ts': { statements: 14, branches: 10, functions: 0, lines: 14 },
        'src/openclaw-bridge.ts': { statements: 90, branches: 65, functions: 90, lines: 90 },
        'src/openclaw-inject.ts': { statements: 53, branches: 25, functions: 45, lines: 55 },
        'src/triologue-bridge.ts': { statements: 70, branches: 38, functions: 68, lines: 70 },
        'src/metrics.ts': { statements: 60, branches: 42, functions: 75, lines: 62 },
        // The 100 floor is deliberate (file is fully covered today); when the
        // file changes, re-measure and ratchet consciously, do not lower
        // reflexively.
        'src/read-tracker.ts': { statements: 100, branches: 100, functions: 100, lines: 100 },
      },
    },
  },
});
