import { NextResponse, after } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth/session";
import { actorFromSession, AuthorizationError, NotFoundError, ValidationError } from "@/lib/authz";
import { sameOrigin } from "@/lib/http";
import { sql } from "@/lib/db";
import { processMessage } from "@/server/agent/processMessage";

export const maxDuration = 120;

const CHAT_LIMIT_PER_10_MIN = Number(process.env.CHAT_LIMIT_PER_10_MIN ?? 40);

const Body = z.object({
  content: z.string().min(1).max(8000),
  conversationId: z.string().uuid().nullish(),
  caseId: z.string().uuid().nullish(),
});

/** Web channel adapter → channel-independent processMessage(). */
export async function POST(req: Request) {
  if (!sameOrigin(req)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  // Per-user cap on agent turns (each turn may make several model calls).
  const [{ recent }] = await sql<{ recent: number }[]>`
    SELECT count(*)::int AS recent FROM messages m JOIN conversations c ON c.id = m.conversation_id
    WHERE c.user_id = ${user.id} AND m.role = 'user' AND m.created_at > now() - interval '10 minutes'`;
  if (recent >= CHAT_LIMIT_PER_10_MIN) {
    return NextResponse.json({ error: "You're sending messages very quickly. Please wait a few minutes and try again." }, { status: 429 });
  }
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  try {
    const message = await processMessage(
      { actor: actorFromSession(user), channel: "web", content: parsed.data.content, conversationId: parsed.data.conversationId, caseId: parsed.data.caseId },
      { runExtraction: (job) => after(() => job().catch((e) => console.error("[agent] extraction failed", e))) },
    );
    return NextResponse.json({ message });
  } catch (err) {
    if (err instanceof ValidationError || err instanceof NotFoundError) return NextResponse.json({ error: err.message }, { status: 400 });
    if (err instanceof AuthorizationError) return NextResponse.json({ error: err.message }, { status: 403 });
    console.error("[api/chat]", err);
    return NextResponse.json({ error: "The message could not be processed. Please try again." }, { status: 500 });
  }
}
