import { defineConfig } from 'vitest/config';

export const TEST_DB = process.env.TEST_DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/newtonite_test';

export default defineConfig({
  test: {
    globalSetup: './tests/globalSetup.js',
    fileParallelism: false,       // files share one DB; tests inside a file may still fire parallel requests
    testTimeout: 20000,
    env: { DATABASE_URL: TEST_DB, JWT_SECRET: 'test-secret', JOB_BACKOFF_BASE_SECONDS: '0' },
  },
});
