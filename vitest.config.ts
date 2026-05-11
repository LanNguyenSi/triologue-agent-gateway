import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    testTimeout: 10000,
    // Restrict to source tests; default glob also matches dist/**/*.test.js after build.
    include: ['src/**/*.{test,spec}.ts'],
  },
});
