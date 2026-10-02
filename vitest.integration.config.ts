import { defineConfig } from "vitest/config";

/**
 * Integration tests: real Postgres + Redis from docker-compose, mocked LLM.
 *
 *   docker compose up -d --wait
 *   npm run test:int
 *
 * They run against a separate `sifter_test` database and Redis DB 1, never
 * the dev data in `sifter` / DB 0, because every test truncates tables.
 * The global setup creates and migrates `sifter_test` if needed.
 */
export const TEST_DATABASE_URL = "postgres://sifter:sifter@localhost:5433/sifter_test";
export const TEST_REDIS_URL = "redis://localhost:6380/1";

export default defineConfig({
  test: {
    include: ["tests/integration/**/*.int.test.ts"],
    environment: "node",
    globalSetup: ["tests/integration/global-setup.ts"],
    // Tests share one database; running files in parallel would let one
    // file's TRUNCATE wipe another's rows mid-assertion.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    env: {
      NODE_ENV: "test",
      DATABASE_URL: TEST_DATABASE_URL,
      REDIS_URL: TEST_REDIS_URL,
      // The dead-letter tests log at error level by design; keep the output readable.
      LOG_LEVEL: "fatal",
      // Never reach a real provider from here, whatever .env says.
      LLM_PROVIDER: "ollama",
      OLLAMA_BASE_URL: "http://127.0.0.1:1",
    },
  },
});
