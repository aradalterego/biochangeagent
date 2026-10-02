import { execSync } from "node:child_process";

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://postgres@localhost:5432/biochange_test";

/** Fresh schema + seed (reference + demo data) for the test database. */
export default function setup() {
  execSync("npm run --silent db:reset", {
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL, OPENAI_API_KEY: "", SEED_DEMO: "true", DEMO_PASSWORD: "DemoVet2026!", NODE_ENV: "test" },
  });
}
