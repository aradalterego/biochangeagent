import "server-only";
import { sql } from "@/lib/db";
import { audit, type OpContext } from "@/lib/audit";
import { NotFoundError, type Actor } from "@/lib/authz";
import { toOrTsQuery } from "@/server/knowledge/retrieve";
import { recomputeAdoption } from "./adoption";

export interface EducationResource {
  id: string;
  title: string;
  resource_type: string;
  product: string | null;
  url: string | null;
  source_id: string | null;
  description: string | null;
  level: string | null;
  counts_as_training: boolean;
  opened: boolean;
  completed: boolean;
}

export async function listEducation(actor: Actor, filter: { product?: string | null; query?: string | null; limit?: number } = {}) {
  const tsq = filter.query ? toOrTsQuery(filter.query) : null;
  return sql<EducationResource[]>`
    SELECT r.id, r.title, r.resource_type, r.product, r.url, r.source_id, r.description, r.level, r.counts_as_training,
      EXISTS (SELECT 1 FROM education_activity a WHERE a.resource_id = r.id AND a.user_id = ${actor.userId}) AS opened,
      EXISTS (SELECT 1 FROM education_activity a WHERE a.resource_id = r.id AND a.user_id = ${actor.userId} AND a.completed) AS completed
    FROM education_resources r
    LEFT JOIN knowledge_sources s ON s.id = r.source_id
    WHERE r.active
      AND (r.source_id IS NULL OR s.status = 'approved')
      AND (${filter.product ?? null}::text IS NULL OR r.product IS NULL OR lower(r.product) = lower(${filter.product ?? null}))
      AND (${tsq}::text IS NULL OR to_tsvector('english', r.title || ' ' || coalesce(r.description, '') || ' ' || r.resource_type)
             @@ to_tsquery('english', ${tsq}))
    ORDER BY CASE r.level WHEN 'intro' THEN 0 WHEN 'intermediate' THEN 1 ELSE 2 END, r.title
    LIMIT ${Math.min(filter.limit ?? 50, 100)}`;
}

/** Records that the user opened/completed an education resource; completed training updates the profile. */
export async function recordTrainingActivity(actor: Actor, resourceId: string, completed: boolean, ctx: OpContext = {}) {
  const [r] = await sql<{ id: string; resource_type: string; product: string | null; counts_as_training: boolean; title: string }[]>`
    SELECT id, resource_type, product, counts_as_training, title FROM education_resources WHERE id = ${resourceId} AND active`;
  if (!r) throw new NotFoundError("Education resource not found");
  await sql.begin(async (tx) => {
    await tx`INSERT INTO education_activity (user_id, resource_id, resource_type, completed, completed_at)
             VALUES (${actor.userId}, ${r.id}, ${r.resource_type}, ${completed}, ${completed ? new Date() : null})`;
    if (completed && r.counts_as_training && r.product) {
      const col = r.product === "ReGum Vet" ? "regum_training_status" : r.product === "MicroFoam" ? "microfoam_training_status" : null;
      if (col) {
        await tx`INSERT INTO veterinarian_profiles ${tx({ user_id: actor.userId, [col]: "completed" })}
                 ON CONFLICT (user_id) DO UPDATE SET ${tx({ [col]: "completed" })}, updated_at = now()`;
      }
    }
    await audit(actor, { action: completed ? "education.complete" : "education.open", entityType: "education_resource", entityId: r.id,
      tool: ctx.tool ?? "ui", sourceMessageId: ctx.sourceMessageId, inputSummary: r.title }, tx);
  });
  if (completed) await recomputeAdoption(actor.userId);
  return { recorded: true, resource: r.title, completed };
}
