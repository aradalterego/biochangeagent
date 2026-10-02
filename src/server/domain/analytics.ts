import "server-only";
import { sql } from "@/lib/db";
import { assertBioChangeAdmin, type Actor } from "@/lib/authz";

/**
 * Aggregate adoption & knowledge analytics for BioChange. Only counts and medians are
 * returned — no individual clinic's clinical details.
 */
export async function getAnalytics(actor: Actor) {
  assertBioChangeAdmin(actor);
  const [counts] = await sql<Record<string, number>[]>`
    SELECT
      (SELECT count(*)::int FROM users WHERE role IN ('veterinarian', 'clinic_admin')) AS registered_vets,
      (SELECT count(*)::int FROM adoption_states WHERE state NOT IN ('lead', 'interested')) AS trained_or_beyond,
      (SELECT count(*)::int FROM veterinarian_profiles WHERE regum_training_status = 'completed' OR microfoam_training_status = 'completed') AS trained_vets,
      (SELECT count(DISTINCT clinic_id)::int FROM inventory_events WHERE event_type = 'usage') AS clinics_with_first_use,
      (SELECT count(*)::int FROM users WHERE last_active_at > now() - interval '30 days' AND role IN ('veterinarian', 'clinic_admin')) AS active_users_30d,
      (SELECT count(*)::int FROM adoption_states WHERE state = 'repeat_user') AS repeat_users,
      (SELECT count(*)::int FROM cases) AS recorded_cases,
      (SELECT coalesce(sum(quantity), 0)::int FROM inventory_events WHERE event_type = 'usage') AS units_used,
      (SELECT count(*)::int FROM (SELECT clinic_id FROM orders WHERE status NOT IN ('draft', 'cancelled') GROUP BY clinic_id HAVING count(*) > 1) x) AS reordering_clinics,
      (SELECT count(*)::int FROM messages WHERE role = 'user') AS questions_asked,
      (SELECT coalesce(sum(frequency), 0)::int FROM knowledge_gaps) AS unanswered_questions,
      (SELECT count(*)::int FROM medical_support_requests) AS escalations,
      (SELECT count(*)::int FROM follow_ups WHERE status = 'completed') AS follow_ups_completed,
      (SELECT count(*)::int FROM follow_ups WHERE status = 'scheduled' AND due_at < current_date) AS follow_ups_overdue,
      (SELECT count(*)::int FROM follow_ups) AS follow_ups_total`;

  const [timing] = await sql<{ training_to_first_use_days: number | null; first_to_second_use_days: number | null }[]>`
    WITH trained AS (
      SELECT a.user_id, min(t.created_at) AS trained_at FROM adoption_transitions t JOIN adoption_states a ON a.user_id = t.user_id
      WHERE t.to_state = 'trained' GROUP BY a.user_id),
    uses AS (
      SELECT e.created_by AS user_id, e.created_at, row_number() OVER (PARTITION BY e.clinic_id ORDER BY e.created_at) AS n, e.clinic_id
      FROM inventory_events e WHERE e.event_type = 'usage'),
    first_second AS (
      SELECT clinic_id, max(created_at) FILTER (WHERE n = 1) AS first_use, max(created_at) FILTER (WHERE n = 2) AS second_use
      FROM uses GROUP BY clinic_id)
    SELECT
      (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM (u.created_at - t.trained_at)) / 86400)
         FROM trained t JOIN uses u ON u.user_id = t.user_id AND u.n = 1 WHERE u.created_at > t.trained_at) AS training_to_first_use_days,
      (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM (second_use - first_use)) / 86400)
         FROM first_second WHERE second_use IS NOT NULL) AS first_to_second_use_days`;

  const adoption = await sql<{ state: string; n: number }[]>`SELECT state, count(*)::int AS n FROM adoption_states GROUP BY state ORDER BY n DESC`;
  const usageByProduct = await sql<{ product: string; units: number }[]>`
    SELECT p.product_family AS product, coalesce(sum(e.quantity), 0)::int AS units
    FROM products p LEFT JOIN inventory_events e ON e.product_id = p.id AND e.event_type = 'usage'
    GROUP BY p.product_family ORDER BY units DESC`;
  const topGaps = await sql<{ question: string; frequency: number; product: string | null }[]>`
    SELECT question, frequency, product FROM knowledge_gaps WHERE status = 'open' ORDER BY frequency DESC LIMIT 10`;
  const topSources = await sql<{ title: string; n: number }[]>`
    SELECT s->>'title' AS title, count(*)::int AS n
    FROM messages m, jsonb_array_elements(coalesce(m.metadata->'sources', '[]'::jsonb)) s
    WHERE m.role = 'assistant' GROUP BY 1 ORDER BY n DESC LIMIT 10`;
  const intents = await sql<{ intent: string; n: number }[]>`
    SELECT metadata->'classification'->>'primary_intent' AS intent, count(*)::int AS n
    FROM messages WHERE role = 'assistant' AND metadata->'classification'->>'primary_intent' IS NOT NULL
    GROUP BY 1 ORDER BY n DESC LIMIT 12`;

  return { counts, timing, adoption, usageByProduct, topGaps, topSources, intents };
}
