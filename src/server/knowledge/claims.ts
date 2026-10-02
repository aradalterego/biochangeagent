import "server-only";
import { sql } from "@/lib/db";
import { audit } from "@/lib/audit";
import { assertKnowledgeManager, ValidationError, type Actor } from "@/lib/authz";
import { CLAIM_TYPES } from "./constants";

export interface ClaimRow {
  id: string;
  claim: string;
  product: string;
  claim_type: string;
  market: string;
  source_id: string | null;
  source_title: string | null;
  allowed_context: string | null;
  restricted_wording: string | null;
  status: "draft" | "approved" | "retired";
}

/** Approved claims whose supporting source (if any) is itself approved. Used by the agent. */
export async function getApprovedClaims(q: { product?: string | null; claimType?: string | null; market?: string | null }) {
  return sql<ClaimRow[]>`
    SELECT a.id, a.claim, a.product, a.claim_type, a.market, a.source_id, s.title AS source_title, a.allowed_context,
           a.restricted_wording, a.status
    FROM approved_claims a LEFT JOIN knowledge_sources s ON s.id = a.source_id
    WHERE a.status = 'approved' AND (a.source_id IS NULL OR s.status = 'approved')
      AND (${q.product ?? null}::text IS NULL OR lower(a.product) = lower(${q.product ?? null}))
      AND (${q.claimType ?? null}::text IS NULL OR a.claim_type = ${q.claimType ?? null})
      AND (${q.market ?? null}::text IS NULL OR a.market IN ('global', ${q.market ?? null}))
    ORDER BY a.product, a.claim_type`;
}

export async function listClaims(actor: Actor) {
  assertKnowledgeManager(actor);
  return sql<ClaimRow[]>`
    SELECT a.*, s.title AS source_title FROM approved_claims a LEFT JOIN knowledge_sources s ON s.id = a.source_id
    ORDER BY a.status, a.product, a.claim_type`;
}

export async function saveClaim(
  actor: Actor,
  input: { id?: string | null; claim: string; product: string; claimType: string; market?: string | null; sourceId?: string | null;
    allowedContext?: string | null; restrictedWording?: string | null; status: "draft" | "approved" | "retired" },
) {
  assertKnowledgeManager(actor);
  if (!input.claim?.trim() || !input.product?.trim()) throw new ValidationError("Claim and product are required.");
  if (!(CLAIM_TYPES as readonly string[]).includes(input.claimType)) throw new ValidationError("Unknown claim type.");
  if (input.status === "approved" && !input.sourceId) throw new ValidationError("An approved claim must reference a supporting source.");
  const values = {
    claim: input.claim.trim(), product: input.product.trim(), claim_type: input.claimType, market: input.market || "global",
    source_id: input.sourceId || null, allowed_context: input.allowedContext || null, restricted_wording: input.restrictedWording || null,
    status: input.status,
  };
  const id = await sql.begin(async (tx) => {
    const [row] = input.id
      ? await tx<{ id: string }[]>`UPDATE approved_claims SET ${tx(values)}, updated_at = now() WHERE id = ${input.id} RETURNING id`
      : await tx<{ id: string }[]>`INSERT INTO approved_claims ${tx(values)} RETURNING id`;
    await audit(actor, { action: input.id ? "claim.update" : "claim.create", entityType: "approved_claim", entityId: row.id, tool: "admin",
      inputSummary: `[${input.status}] ${input.claim}` }, tx);
    return row.id;
  });
  return id;
}
