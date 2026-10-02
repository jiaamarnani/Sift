import { defineConfig } from "drizzle-kit";
import "dotenv/config";

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://sifter:sifter@localhost:5433/sifter",
  },
  // Emit plain .sql files we commit and review, rather than pushing schema
  // diffs straight at the database.
  verbose: true,
  strict: true,
});
