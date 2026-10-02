import Link from "next/link";
import type { SessionUser } from "@/lib/auth/session";
import { actorFromSession } from "@/lib/authz";
import { isClinicRole } from "@/lib/roles";
import { getCase } from "@/server/domain/cases";
import { getInventory } from "@/server/domain/inventory";
import { fmtDate } from "@/lib/format";
import { Badge, statusTone } from "@/components/ui";
import type { ChatMessage } from "./types";

/** Collapsible right panel: active case, relevant product stock, sources used. */
export async function ContextPanel({ user, activeCaseId, messages }: { user: SessionUser; activeCaseId: string | null; messages: ChatMessage[] }) {
  const actor = actorFromSession(user);
  const clinic = isClinicRole(user.role) && user.clinicId;
  const c = activeCaseId && clinic ? await getCase(actor, activeCaseId).catch(() => null) : null;
  const productFamily = c?.case.product_name ?? null;
  const inventory = clinic ? await getInventory(actor) : [];
  const relevant = productFamily ? inventory.filter((l) => l.product === productFamily) : inventory;
  const sources = new Map<string, { title: string; sourceId: string; authorityLevel: number }>();
  for (const m of messages) for (const s of m.sources) sources.set(s.sourceId, { title: s.title, sourceId: s.sourceId, authorityLevel: s.authorityLevel });

  return (
    <details open className="group hidden w-80 shrink-0 border-l border-line bg-white xl:block">
      <summary className="cursor-pointer list-none border-b border-line px-4 py-3 text-xs font-semibold uppercase tracking-wider text-muted">Context</summary>
      <div className="space-y-6 overflow-y-auto px-4 py-4 text-sm">
        <div>
          <div className="mb-1.5 text-xs font-semibold text-muted">Active case</div>
          {c ? (
            <Link href={`/cases/${c.case.id}`} className="block rounded-lg border border-line p-3 hover:border-brand">
              <div className="flex items-center justify-between">
                <span className="font-medium">{c.case.tooth ? `Tooth ${c.case.tooth}` : "Case"}{c.case.internal_patient_identifier ? ` · ${c.case.internal_patient_identifier}` : ""}</span>
                <Badge tone={statusTone(c.case.status)}>{c.case.status.replace(/_/g, " ")}</Badge>
              </div>
              <div className="mt-1 text-xs text-muted">{c.case.condition_summary ?? "—"}</div>
              <div className="mt-1 text-xs text-muted">
                {c.case.pocket_depth_mm ? `PD ${c.case.pocket_depth_mm} mm · ` : ""}{c.case.product_name ?? "No product"} · next follow-up {fmtDate(c.case.next_follow_up)}
              </div>
            </Link>
          ) : (
            <p className="text-xs text-muted">No case linked to this conversation.</p>
          )}
        </div>
        {clinic && (
          <div>
            <div className="mb-1.5 text-xs font-semibold text-muted">Clinic inventory</div>
            {relevant.length ? (
              <ul className="space-y-1.5">
                {relevant.map((l) => (
                  <li key={l.productId} className="rounded-lg bg-canvas px-3 py-2">
                    <div className="font-medium">{l.product}</div>
                    <div className="text-xs text-muted">
                      Estimated stock: {l.quantityEstimated ?? "—"} · confirmed {l.quantityConfirmed ?? "—"}
                      {l.lastConfirmedAt ? ` (${fmtDate(l.lastConfirmedAt)})` : ""}
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-muted">No inventory recorded.</p>
            )}
          </div>
        )}
        <div>
          <div className="mb-1.5 text-xs font-semibold text-muted">Sources used</div>
          {sources.size ? (
            <ul className="space-y-1.5">
              {[...sources.values()].map((s) => (
                <li key={s.sourceId}>
                  <Link href={`/sources/${s.sourceId}`} target="_blank" className="text-brand hover:underline">{s.title}</Link>
                  <span className="ml-1 text-xs text-muted">(level {s.authorityLevel})</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-muted">Cited sources will appear here.</p>
          )}
        </div>
      </div>
    </details>
  );
}
