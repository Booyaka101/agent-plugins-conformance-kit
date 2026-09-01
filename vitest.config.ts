import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Fixture plugins are deliberately malformed input, never test sources.
    exclude: ['node_modules/**', 'dist/**', 'fixtures/**'],
    testTimeout: 120_000,
  },
});
