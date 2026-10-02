import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Unit tests live next to the code (src/**/*.test.ts); integration tests
    // that need Postgres/Redis live in tests/integration and are named .int.test.ts
    // so CI can run the two groups separately. They have their own config
    // (vitest.integration.config.ts, `npm run test:int`), so `npm test` needs
    // no running infrastructure.
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
    exclude: [...configDefaults.exclude, "tests/integration/**"],
    environment: "node",
    globals: false,
    env: {
      NODE_ENV: "test",
      // Overridden by a real .env when present; these keep env.ts from exiting.
      DATABASE_URL: process.env.DATABASE_URL ?? "postgres://sifter:sifter@localhost:5433/sifter",
      REDIS_URL: process.env.REDIS_URL ?? "redis://localhost:6380",
      LOG_LEVEL: "error",
    },
  },
});
