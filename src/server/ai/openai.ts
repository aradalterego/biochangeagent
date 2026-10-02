import "server-only";
import OpenAI from "openai";
import { env } from "@/lib/env";

let client: OpenAI | undefined;

/** Server-side OpenAI client. The API key never leaves the server. */
export function openai(): OpenAI {
  const key = env().OPENAI_API_KEY;
  if (!key) throw new OpenAINotConfiguredError();
  return (client ??= new OpenAI({ apiKey: key, maxRetries: 2, timeout: 90_000 }));
}

export class OpenAINotConfiguredError extends Error {
  constructor() {
    super("OPENAI_API_KEY is not configured on the server.");
    this.name = "OpenAINotConfiguredError";
  }
}

/** Vector size stored in knowledge_chunks.embedding. */
export const EMBEDDING_DIMENSIONS = 1536;

export async function embed(texts: string[]): Promise<number[][] | null> {
  if (!env().OPENAI_API_KEY || texts.length === 0) return null;
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += 64) {
    const batch = texts.slice(i, i + 64).map((t) => t.slice(0, 24_000));
    const res = await openai().embeddings.create({
      model: env().OPENAI_EMBEDDING_MODEL,
      input: batch,
      dimensions: EMBEDDING_DIMENSIONS,
    });
    out.push(...res.data.map((d) => d.embedding));
  }
  return out;
}

export function toVectorLiteral(v: number[]): string {
  return `[${v.join(",")}]`;
}
