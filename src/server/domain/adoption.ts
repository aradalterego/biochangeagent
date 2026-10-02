import "server-only";
import { sql } from "@/lib/db";
import { audit, type OpContext } from "@/lib/audit";
import { ValidationError, type Actor } from "@/lib/authz";

export const ADOPTION_STATES = ["lead", "interested", "trained", "ordered", "first_use_pending", "first_use_completed", "active", "repeat_user", "dormant"] as const;
export type AdoptionState = (typeof ADOPTION_STATES)[number];

export const ADOPTION_HINTS: Record<AdoptionState, string> = {
  lead: "Not yet engaged. Be helpful and informative; no pressure.",
  interested: "Registered but not trained. Point to the most relevant introductory education when useful.",
  trained: "Trained but no order recorded. Help with case selection questions; mention ordering only if asked.",
  ordered: "An order is on the way. Help prepare for the first case.",
  first_use_pending: "Has product but no recorded use. Offer first-use support: the right protocol, a relevant case study, saving the first case.",
  first_use_completed: "One recorded use. Support follow-up of that case and confidence for the second case.",
  active: "Uses the product repeatedly. Be efficient; help with follow-ups and stock.",
  repeat_user: "Has reordered. Integrated user; keep stock and follow-ups smooth.",
  dormant: "No recent use or orders. Ask whether anything got in the way; do not push sales.",
};

const DORMANT_DAYS = 120;

/**
 * Infers a practical adoption state from recorded data. It is deliberately simple:
 * its purpose is to tell the agent what kind of help is most useful.
 */
export async function inferAdoption(userId: string): Promise<{ state: AdoptionState; reason: string }> {
  const [r] = await sql<{
    clinic_id: string | null; trained: boolean; orders: number; received: number; uses: number; last_activity: Date | null; has_stock: boolean;
  }[]>`
    SELECT u.clinic_id,
      (coalesce(vp.regum_training_status, '') = 'completed' OR coalesce(vp.microfoam_training_status, '') = 'completed'
        OR EXISTS (SELECT 1 FROM education_activity ea JOIN education_resources er ON er.id = ea.resource_id
                   WHERE ea.user_id = u.id AND ea.completed AND er.counts_as_training)) AS trained,
      (SELECT count(*)::int FROM orders o WHERE o.clinic_id = u.clinic_id AND o.status NOT IN ('draft', 'cancelled')) AS orders,
      (SELECT count(*)::int FROM orders o WHERE o.clinic_id = u.clinic_id AND o.status = 'received') AS received,
      (SELECT count(*)::int FROM inventory_events e WHERE e.clinic_id = u.clinic_id AND e.event_type = 'usage') AS uses,
      greatest(
        (SELECT max(created_at) FROM inventory_events e WHERE e.clinic_id = u.clinic_id AND e.event_type = 'usage'),
        (SELECT max(created_at) FROM orders o WHERE o.clinic_id = u.clinic_id AND o.status NOT IN ('draft', 'cancelled'))) AS last_activity,
      EXISTS (SELECT 1 FROM inventory i WHERE i.clinic_id = u.clinic_id AND coalesce(i.quantity_estimated, i.quantity_confirmed, 0) > 0) AS has_stock
    FROM users u LEFT JOIN veterinarian_profiles vp ON vp.user_id = u.id
    WHERE u.id = ${userId}`;
  if (!r) return { state: "lead", reason: "unknown user" };
  const idleDays = r.last_activity ? (Date.now() - r.last_activity.getTime()) / 864e5 : null;
  if ((r.uses > 0 || r.orders > 0) && idleDays != null && idleDays > DORMANT_DAYS) {
    return { state: "dormant", reason: `No recorded use or order for ${Math.round(idleDays)} days` };
  }
  if (r.orders >= 2) return { state: "repeat_user", reason: `${r.orders} orders recorded` };
  if (r.uses >= 2) return { state: "active", reason: `${r.uses} uses recorded` };
  if (r.uses === 1) return { state: "first_use_completed", reason: "First use recorded" };
  if (r.received > 0 || r.has_stock) return { state: "first_use_pending", reason: "Product in stock, no use recorded yet" };
  if (r.orders > 0) return { state: "ordered", reason: "Order recorded" };
  if (r.trained) return { state: "trained", reason: "Training completed" };
  return { state: "interested", reason: "Registered" };
}

export async function getAdoptionState(userId: string): Promise<{ state: AdoptionState; reason: string | null; last_transition_at: Date | null }> {
  const [row] = await sql<{ state: AdoptionState; reason: string | null; last_transition_at: Date }[]>`
    SELECT state, reason, last_transition_at FROM adoption_states WHERE user_id = ${userId}`;
  if (row) return row;
  return recomputeAdoption(userId);
}

/** Recomputes and stores the inferred state, recording a transition when it changes. */
export async function recomputeAdoption(userId: string) {
  const next = await inferAdoption(userId);
  const [cur] = await sql<{ state: AdoptionState }[]>`SELECT state FROM adoption_states WHERE user_id = ${userId}`;
  if (cur?.state === next.state) {
    return { state: next.state, reason: next.reason, last_transition_at: null };
  }
  await sql.begin(async (tx) => {
    await tx`INSERT INTO adoption_states (user_id, clinic_id, state, reason)
             VALUES (${userId}, (SELECT clinic_id FROM users WHERE id = ${userId}), ${next.state}, ${next.reason})
             ON CONFLICT (user_id) DO UPDATE SET state = EXCLUDED.state, reason = EXCLUDED.reason, last_transition_at = now()`;
    await tx`INSERT INTO adoption_transitions (user_id, from_state, to_state, reason) VALUES (${userId}, ${cur?.state ?? null}, ${next.state}, ${next.reason})`;
  });
  return { state: next.state, reason: next.reason, last_transition_at: new Date() };
}

/** Manual adjustment (e.g. the vet says they stopped using the product). */
export async function updateAdoptionState(actor: Actor, state: AdoptionState, reason: string, ctx: OpContext = {}) {
  if (!ADOPTION_STATES.includes(state)) throw new ValidationError("Unknown adoption state");
  const [cur] = await sql<{ state: AdoptionState }[]>`SELECT state FROM adoption_states WHERE user_id = ${actor.userId}`;
  await sql.begin(async (tx) => {
    await tx`INSERT INTO adoption_states (user_id, clinic_id, state, reason) VALUES (${actor.userId}, ${actor.clinicId}, ${state}, ${reason})
             ON CONFLICT (user_id) DO UPDATE SET state = EXCLUDED.state, reason = EXCLUDED.reason, last_transition_at = now()`;
    await tx`INSERT INTO adoption_transitions (user_id, from_state, to_state, reason) VALUES (${actor.userId}, ${cur?.state ?? null}, ${state}, ${reason})`;
    await audit(actor, { action: "adoption.update", entityType: "adoption_state", entityId: actor.userId, tool: ctx.tool, sourceMessageId: ctx.sourceMessageId,
      inputSummary: `${cur?.state ?? "none"} → ${state}: ${reason}` }, tx);
  });
  return { state, reason };
}
