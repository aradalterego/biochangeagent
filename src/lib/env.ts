import "server-only";
import { z } from "zod";

const schema = z.object({
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
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),
  SUPABASE_STORAGE_BUCKET: z.string().default("private-files"),
  SESSION_TTL_HOURS: z.coerce.number().int().positive().default(12),
  KNOWLEDGE_FETCH_ALLOWED_HOSTS: z.string().default("biochange.life"),
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

export function isOpenAIConfigured(): boolean {
  return Boolean(env().OPENAI_API_KEY);
}
