import { afterAll, afterEach, describe, expect, it } from "vitest";
import { closeDb } from "@/lib/db";
import { env, isDemoEnvironment, resetEnvCache } from "@/lib/env";
import { sameOrigin } from "@/lib/http";
import { completeSignIn } from "@/lib/auth/signin";

const STAGING = {
  APP_ENV: "staging", APP_URL: "https://biochange-demo.vercel.app", SUPABASE_URL: "https://x.supabase.co", SUPABASE_ANON_KEY: "anon",
  STORAGE_DRIVER: "supabase", AUTH_PROVIDER: "supabase", AUTH_ENCRYPTION_KEY: "1".repeat(64), CRON_SECRET: "c".repeat(64), EMAIL_DRIVER: "none",
};
const saved = { ...process.env };

function withEnv(vars: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(vars)) (v === undefined ? delete process.env[k] : (process.env[k] = v));
  resetEnvCache();
}

afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
  resetEnvCache();
});
afterAll(() => closeDb());

describe("demo environment", () => {
  it("allows a staging demo without email but never demo data in production", () => {
    withEnv({ ...STAGING, ALLOW_DEMO_IN_PRODUCTION: "true" });
    expect(isDemoEnvironment()).toBe(true);
    withEnv({ ...STAGING, APP_ENV: "production", ALLOW_DEMO_IN_PRODUCTION: "true", EMAIL_DRIVER: "resend", RESEND_API_KEY: "k" });
    expect(() => env()).toThrow(/ALLOW_DEMO_IN_PRODUCTION/);
    withEnv({ ...STAGING, APP_ENV: "production", ALLOW_DEMO_IN_PRODUCTION: "false" });
    expect(() => env()).toThrow(/EMAIL_DRIVER/); // production needs real email
    withEnv({ ...STAGING, CRON_SECRET: "short" });
    expect(() => env()).toThrow(/CRON_SECRET/);
  });

  it("lets demo accounts sign in only in a demo environment", async () => {
    const demo = { provider: "dev" as const, subject: "email:vet@demo.biochange.test", email: "vet@demo.biochange.test", method: "magic_link" as const };
    withEnv({ ...STAGING, ALLOW_DEMO_IN_PRODUCTION: "false" });
    expect(await completeSignIn(demo, null)).toEqual({ ok: false, reason: "not_invited" });
    withEnv({ ...STAGING, ALLOW_DEMO_IN_PRODUCTION: "true" });
    expect(await completeSignIn(demo, null)).toMatchObject({ ok: true });
  });

  it("accepts the hostnames Vercel assigns to the deployment, nothing else", () => {
    withEnv({ ...STAGING, ALLOW_DEMO_IN_PRODUCTION: "true", VERCEL_URL: "biochange-demo-abc123.vercel.app" });
    const req = (origin: string) => new Request("https://x/api/chat", { method: "POST", headers: { origin, host: "evil.example" } });
    expect(sameOrigin(req("https://biochange-demo.vercel.app"))).toBe(true);
    expect(sameOrigin(req("https://biochange-demo-abc123.vercel.app"))).toBe(true);
    expect(sameOrigin(req("https://evil.example"))).toBe(false);
  });
});
