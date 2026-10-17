import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts'],
    globals: false,
    environment: 'node',
    testTimeout: 120_000,
    hookTimeout: 300_000,
    pool: 'forks',
    maxWorkers: 1,
    isolate: false,
    fileParallelism: false,
    reporters: ['default'],
  },
});
