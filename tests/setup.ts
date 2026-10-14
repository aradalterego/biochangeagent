import os from "node:os";
import path from "node:path";

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://postgres@localhost:5432/biochange_test";
process.env.OPENAI_API_KEY = "";
process.env.STORAGE_DRIVER = "local";
process.env.LOCAL_STORAGE_DIR = path.join(os.tmpdir(), "biochange-test-storage");
process.env.APP_ENV = "test";
// The acceptance loop exercises optional product areas (inventory, orders) too.
process.env.FEATURES = "all";
process.env.AUTH_PROVIDER = "dev";
process.env.EMAIL_DRIVER = "none";
process.env.AUTH_ENCRYPTION_KEY = "0".repeat(64);
