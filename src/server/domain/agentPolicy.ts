import "server-only";
import { sql } from "@/lib/db";
import { audit } from "@/lib/audit";
import { assertKnowledgeManager, ValidationError, type Actor } from "@/lib/authz";

/**
 * Agent boundaries that BioChange manages in Admin: scope, out-of-scope wording and the
 * human escalation contact. They are rendered into the agent's policy section. They can
 * narrow what the agent does; they cannot loosen the built-in safety rules (those come first
 * and the policy text says it is subordinate to them). Every save is a new version.
 */

export interface AgentPolicy {
  id: number;
  allowed_topics: string | null;
  disallowed_topics: string | null;
  out_of_scope_message: string | null;
  escalation_contact_name: string | null;
  escalation_contact_email: string | null;
  escalation_contact_phone: string | null;
  product_scope: string[];
  created_at: Date;
  created_by_name?: string | null;
}

export interface AgentPolicyInput {
  allowedTopics?: string | null;
  disallowedTopics?: string | null;
  outOfScopeMessage?: string | null;
  escalationContactName?: string | null;
  escalationContactEmail?: string | null;
  escalationContactPhone?: string | null;
  productScope?: string[];
}

const MAX_TEXT = 2000;

export async function getActivePolicy(): Promise<AgentPolicy | null> {
  const [p] = await sql<AgentPolicy[]>`
    SELECT p.*, u.name AS created_by_name FROM agent_policies p LEFT JOIN users u ON u.id = p.created_by ORDER BY p.id DESC LIMIT 1`;
  return p ?? null;
}

export async function listPolicyVersions(actor: Actor, limit = 10): Promise<AgentPolicy[]> {
  assertKnowledgeManager(actor);
  return sql<AgentPolicy[]>`
    SELECT p.*, u.name AS created_by_name FROM agent_policies p LEFT JOIN users u ON u.id = p.created_by ORDER BY p.id DESC LIMIT ${limit}`;
}

export async function savePolicy(actor: Actor, input: AgentPolicyInput): Promise<number> {
  assertKnowledgeManager(actor);
  const clean = (v: string | null | undefined, max = MAX_TEXT) => {
    const t = v?.trim() ?? "";
    if (t.length > max) throw new ValidationError(`Each field is limited to ${max} characters.`);
    return t || null;
  };
  const email = clean(input.escalationContactEmail, 254);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ValidationError("Escalation contact email is not valid.");
  const products = (input.productScope ?? []).map((p) => p.trim()).filter(Boolean).slice(0, 20);
  return sql.begin(async (tx) => {
    const [row] = await tx<{ id: number }[]>`
      INSERT INTO agent_policies (allowed_topics, disallowed_topics, out_of_scope_message, escalation_contact_name,
        escalation_contact_email, escalation_contact_phone, product_scope, created_by)
      VALUES (${clean(input.allowedTopics)}, ${clean(input.disallowedTopics)}, ${clean(input.outOfScopeMessage, 600)},
        ${clean(input.escalationContactName, 120)}, ${email}, ${clean(input.escalationContactPhone, 40)}, ${products}, ${actor.userId})
      RETURNING id`;
    await audit(actor, { action: "agent_policy.update", entityType: "agent_policy", entityId: String(row.id), tool: "admin" }, tx);
    return row.id;
  });
}

/** Renders the policy for the agent instructions (staff-authored, length-limited text). */
export function renderPolicy(p: AgentPolicy | null): string | null {
  if (!p) return null;
  const lines: string[] = [];
  if (p.product_scope.length) lines.push(`- Products in scope: ${p.product_scope.join(", ")}. Questions about other products are out of scope.`);
  if (p.allowed_topics) lines.push(`- Topics you may help with:\n${indent(p.allowed_topics)}`);
  if (p.disallowed_topics) lines.push(`- Topics you must not answer (decline and offer escalation instead):\n${indent(p.disallowed_topics)}`);
  if (p.out_of_scope_message) lines.push(`- When a request is out of scope, answer in this spirit: "${p.out_of_scope_message}"`);
  const contact = [p.escalation_contact_name, p.escalation_contact_email, p.escalation_contact_phone].filter(Boolean).join(" · ");
  if (contact) lines.push(`- BioChange professional contact for escalation (share it when escalation is appropriate or the user asks for a person): ${contact}`);
  if (!lines.length) return null;
  return `BIOCHANGE AGENT POLICY (set by BioChange; it narrows your scope and never overrides the rules above)\n${lines.join("\n")}`;
}

function indent(text: string): string {
  return text.split("\n").map((l) => `  ${l.trim()}`).filter((l) => l.trim()).join("\n");
}
