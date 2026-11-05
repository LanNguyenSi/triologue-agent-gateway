import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    testTimeout: 20000,
    // Tests live under tests/ (not src/), like bridge/.
    include: ['tests/**/*.{test,spec}.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: [
        // Entrypoint: a side-effect script (config, wiring, signals), covered
        // by the stdio integration test through a child process the v8
        // provider cannot instrument.
        'src/index.ts',
        // The server itself is exercised end to end by tests/stdio.test.ts,
        // which spawns it as a child process the in-worker v8 provider
        // cannot instrument; its logic beyond the MCP wiring lives in the
        // modules below, which are unit-tested in process.
        'src/server.ts',
      ],
      // Measured 2026-11-05 with src/index.ts and src/server.ts excluded (both run
      // only in the stdio child process): stmts 79 / branches 75 / funcs 85 /
      // lines 79; floors sit about five points below.
      thresholds: {
        statements: 72,
        branches: 68,
        functions: 78,
        lines: 72,
        'src/inbound.ts': { statements: 90, branches: 90, functions: 95, lines: 90 },
        'src/config.ts': { statements: 90, branches: 90, functions: 95, lines: 90 },
      },
    },
  },
});
