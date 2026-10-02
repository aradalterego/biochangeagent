import Link from "next/link";
import { requireUser } from "@/lib/auth/session";
import { actorFromSession } from "@/lib/authz";
import { isBioChangeStaff, isClinicRole } from "@/lib/roles";
import { sql } from "@/lib/db";
import { getTodayCards, type TodayCard } from "@/server/domain/today";
import { searchCases } from "@/server/domain/cases";
import { estimateInventory } from "@/server/domain/inventory";
import { getAdoptionState } from "@/server/domain/adoption";
import { missingCriticalDocuments } from "@/server/knowledge/sources";
import { Badge, Empty, Page, PageHeader, Section, statusTone } from "@/components/ui";
import { fmtDate } from "@/lib/format";

const CARD_TONE: Record<TodayCard["kind"], string> = {
  follow_up_overdue: "border-l-danger",
  follow_up_today: "border-l-warn",
  support_answer: "border-l-brand",
  inventory_low: "border-l-warn",
  draft_order: "border-l-brand",
  follow_up_upcoming: "border-l-line",
  first_use: "border-l-brand",
  training: "border-l-line",
};

export default async function TodayPage() {
  const user = await requireUser();
  const actor = actorFromSession(user);
  const cards = await getTodayCards(actor, user.timezone);
  const clinic = isClinicRole(user.role) && user.clinicId;

  const greeting = summarize(cards);
  return (
    <Page>
      <PageHeader title="Today" subtitle={greeting} actions={<Link href="/chat" className="btn-primary">Ask the companion</Link>} />

      {cards.length > 0 ? (
        <div className="mb-8 grid gap-3 md:grid-cols-2">
          {cards.map((c, i) => (
            <Link key={i} href={c.href} className={`card border-l-4 px-4 py-3 hover:shadow-sm ${CARD_TONE[c.kind]}`}>
              <div className="text-sm font-medium">{c.title}</div>
              <div className="mt-0.5 text-sm text-muted">{c.detail}</div>
            </Link>
          ))}
        </div>
      ) : (
        <div className="mb-8"><Empty>Nothing needs your attention right now.</Empty></div>
      )}

      {clinic && <ClinicOverview actor={actor} userId={user.id} />}
      {isBioChangeStaff(user.role) && <StaffOverview />}
    </Page>
  );
}

function summarize(cards: TodayCard[]): string {
  const due = cards.filter((c) => c.kind.startsWith("follow_up")).length;
  const low = cards.filter((c) => c.kind === "inventory_low").length;
  const parts: string[] = [];
  if (due) parts.push(`${due} follow-up${due > 1 ? "s" : ""} due or coming up this week`);
  if (low) parts.push(`stock may be low for ${low} product${low > 1 ? "s" : ""}`);
  return parts.length ? `You have ${parts.join(", and ")}.` : "Your clinic at a glance.";
}

async function ClinicOverview({ actor, userId }: { actor: ReturnType<typeof actorFromSession>; userId: string }) {
  const [cases, forecasts, adoption] = await Promise.all([
    searchCases(actor, { limit: 6 }).then((r) => r.filter((c) => c.status !== "closed")),
    estimateInventory(actor),
    getAdoptionState(userId),
  ]);
  const [pendingOrder] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM orders WHERE clinic_id = ${actor.clinicId} AND status IN ('draft', 'submitted', 'confirmed', 'shipped')`;
  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <Section title="Active cases" actions={<Link href="/cases" className="text-sm text-brand hover:underline">All cases</Link>}>
        {cases.length ? (
          <ul className="divide-y divide-line">
            {cases.map((c) => (
              <li key={c.id}>
                <Link href={`/cases/${c.id}`} className="flex items-center justify-between py-2 text-sm hover:text-brand">
                  <span>
                    {c.tooth ? `Tooth ${c.tooth}` : "Case"}
                    {c.internal_patient_identifier ? ` · ${c.internal_patient_identifier}` : ""}
                    <span className="text-muted"> · {c.product_name ?? "no product"}</span>
                  </span>
                  <span className="flex items-center gap-2">
                    {c.next_follow_up && <span className="text-xs text-muted">f/u {fmtDate(c.next_follow_up)}</span>}
                    <Badge tone={statusTone(c.status)}>{c.status.replace(/_/g, " ")}</Badge>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted">No active cases. Save a case from the chat or <Link className="text-brand" href="/cases/new">add one</Link>.</p>
        )}
      </Section>
      <Section title="Inventory status" actions={<Link href="/inventory" className="text-sm text-brand hover:underline">Inventory</Link>}>
        {forecasts.length ? (
          <ul className="space-y-2 text-sm">
            {forecasts.map((f) => (
              <li key={f.productId} className="flex items-center justify-between">
                <span>{f.product}</span>
                <span className="text-muted">
                  Estimated stock: <span className={f.likelyLow ? "font-medium text-warn" : "text-ink"}>{f.estimatedStock ?? "—"}</span>
                  {f.weeksUntilStockOut != null && ` · ~${f.weeksUntilStockOut} wk`}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted">No inventory recorded yet.</p>
        )}
        <p className="mt-3 text-xs text-muted">{pendingOrder.n ? `${pendingOrder.n} order(s) in progress.` : "No orders in progress."}</p>
      </Section>
      <Section title="Your journey">
        <p className="text-sm">
          Stage: <Badge tone="brand">{adoption.state.replace(/_/g, " ")}</Badge>
        </p>
        <p className="mt-2 text-sm text-muted">
          {adoption.state === "first_use_pending" && "Ready for a first case? The companion can walk you through the approved protocol and save the case for follow-up."}
          {adoption.state === "interested" && "Start with the introductory material in Education."}
          {adoption.state === "trained" && "When you have a suitable case, ask the companion — it will check the approved criteria with you."}
          {["first_use_completed", "active", "repeat_user"].includes(adoption.state) && "Keep follow-ups up to date so outcomes are documented."}
          {adoption.state === "dormant" && "It's been a while. If something got in the way, the companion or Medical Support can help."}
          {adoption.state === "ordered" && "Your order is on its way. Review the protocol before your first case."}
        </p>
      </Section>
    </div>
  );
}

async function StaffOverview() {
  const [missing, [esc], [gaps], [pending]] = await Promise.all([
    missingCriticalDocuments(),
    sql<{ n: number }[]>`SELECT count(*)::int AS n FROM medical_support_requests WHERE status IN ('new', 'in_review')`,
    sql<{ n: number }[]>`SELECT count(*)::int AS n FROM knowledge_gaps WHERE status = 'open'`,
    sql<{ n: number }[]>`SELECT count(*)::int AS n FROM knowledge_sources WHERE status = 'pending_review' AND NOT is_placeholder`,
  ]);
  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <Section title="Critical documents missing" actions={<Link href="/admin/knowledge" className="text-sm text-brand hover:underline">Knowledge Sources</Link>}>
        {missing.length ? (
          <ul className="list-disc space-y-1 pl-5 text-sm">
            {missing.map((m) => <li key={m.key}>{m.title}</li>)}
          </ul>
        ) : (
          <p className="text-sm text-ok">All critical documents are approved.</p>
        )}
        <p className="mt-3 text-xs text-muted">Public website material alone is not sufficient for a production clinical agent.</p>
      </Section>
      <Section title="Work queue">
        <ul className="space-y-2 text-sm">
          <li><Link className="text-brand hover:underline" href="/admin/escalations">{esc.n} open Medical Support request(s)</Link></li>
          <li><Link className="text-brand hover:underline" href="/admin/knowledge?status=pending_review">{pending.n} source(s) pending review</Link></li>
          <li><Link className="text-brand hover:underline" href="/admin/gaps">{gaps.n} open knowledge gap(s)</Link></li>
        </ul>
      </Section>
    </div>
  );
}
