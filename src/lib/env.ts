import "server-only";
import { z } from "zod";

const flag = (def: "true" | "false") => z.enum(["true", "false"]).default(def).transform((v) => v === "true");

const schema = z
  .object({
    /** Deployment environment. Distinct from NODE_ENV (which is "production" for every built app). */
    APP_ENV: z.enum(["development", "test", "staging", "production"]).default("development"),
    DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
    OPENAI_API_KEY: z.string().optional(),
    OPENAI_MODEL: z.string().default("gpt-5.5"),
    OPENAI_REASONING_EFFORT: z.enum(["none", "minimal", "low", "medium", "high"]).optional(),
    OPENAI_EXTRACTION_MODEL: z.string().default("gpt-5.4-mini"),
    OPENAI_EMBEDDING_MODEL: z.string().default("text-embedding-3-small"),
    APP_URL: z.string().default("http://localhost:3000"),
    STORAGE_DRIVER: z.enum(["local", "supabase"]).default("local"),
    LOCAL_STORAGE_DIR: z.string().default("./storage"),
    SUPABASE_URL: z.string().optional(),
    SUPABASE_ANON_KEY: z.string().optional(),
    SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),
    SUPABASE_STORAGE_BUCKET: z.string().default("private-files"),
    SESSION_TTL_HOURS: z.coerce.number().int().positive().default(12),
    SESSION_IDLE_MINUTES: z.coerce.number().int().positive().default(120),
    STAFF_SESSION_IDLE_MINUTES: z.coerce.number().int().positive().default(30),
    KNOWLEDGE_FETCH_ALLOWED_HOSTS: z.string().default("biochange.life"),
    /** Optional product areas that are outside the MVP (comma-separated): inventory, orders, adoption, education. */
    FEATURES: z.string().default(""),
    /** Identity verification for passwordless sign-in. "dev" issues local one-time links and is refused in production. */
    AUTH_PROVIDER: z.enum(["supabase", "dev"]).default("dev"),
    AUTH_GOOGLE_ENABLED: flag("false"),
    /** 32-byte key (base64 or hex) used to encrypt MFA secrets at rest. */
    AUTH_ENCRYPTION_KEY: z.string().optional(),
    STAFF_MFA_REQUIRED: flag("true"),
    EMAIL_DRIVER: z.enum(["resend", "log", "none"]).default("log"),
    RESEND_API_KEY: z.string().optional(),
    EMAIL_FROM: z.string().default("BioChange <no-reply@biochange.life>"),
  })
  .superRefine((e, ctx) => {
    if (e.APP_ENV !== "production" && e.APP_ENV !== "staging") return;
    const need = (ok: boolean, path: string, message: string) => {
      if (!ok) ctx.addIssue({ code: "custom", path: [path], message });
    };
    need(e.AUTH_PROVIDER === "supabase", "AUTH_PROVIDER", "must be 'supabase' outside development");
    need(Boolean(e.SUPABASE_URL && e.SUPABASE_ANON_KEY), "SUPABASE_ANON_KEY", "SUPABASE_URL and SUPABASE_ANON_KEY are required");
    need(Boolean(e.AUTH_ENCRYPTION_KEY), "AUTH_ENCRYPTION_KEY", "is required outside development");
    need(e.STORAGE_DRIVER === "supabase", "STORAGE_DRIVER", "must be 'supabase' outside development");
    need(e.EMAIL_DRIVER === "resend" && Boolean(e.RESEND_API_KEY), "EMAIL_DRIVER", "must be 'resend' with RESEND_API_KEY outside development");
    need(e.APP_URL.startsWith("https://"), "APP_URL", "must be https outside development");
  });

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;

export function env(): Env {
  if (!cached) {
    const parsed = schema.safeParse(process.env);
    if (!parsed.success) {
      throw new Error(`Invalid environment: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
    }
    cached = parsed.data;
  }
  return cached;
}

/** Tests change process.env between cases; production code never needs this. */
export function resetEnvCache(): void {
  cached = undefined;
}

export function isOpenAIConfigured(): boolean {
  return Boolean(env().OPENAI_API_KEY);
}

export function isProductionLike(): boolean {
  const e = env().APP_ENV;
  return e === "production" || e === "staging";
}
