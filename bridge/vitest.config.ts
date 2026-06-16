import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    testTimeout: 10000,
    // Bridge keeps its tests under tests/ (not src/). Without this config, vitest
    // walks up to the root config (include: src/**) and finds no test files.
    include: ['tests/**/*.{test,spec}.ts'],
  },
});
