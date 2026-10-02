import { requireRole } from "@/lib/auth/session";
import { actorFromSession } from "@/lib/authz";
import { getAnalytics } from "@/server/domain/analytics";
import { Page, PageHeader, Section } from "@/components/ui";

const LABELS: Record<string, string> = {
  registered_vets: "Registered vets", trained_vets: "Trained vets", clinics_with_first_use: "Clinics with first use", active_users_30d: "Active users (30 d)",
  repeat_users: "Repeat users", recorded_cases: "Recorded cases", units_used: "Units used (recorded)", reordering_clinics: "Clinics that reordered",
  questions_asked: "Questions asked", unanswered_questions: "Unanswered questions", escalations: "Medical Support escalations",
  follow_ups_completed: "Follow-ups completed", follow_ups_overdue: "Follow-ups overdue", follow_ups_total: "Follow-ups scheduled (all)",
};

export default async function AnalyticsPage() {
  const user = await requireRole(["biochange_admin"]);
  const a = await getAnalytics(actorFromSession(user));
  const followRate = a.counts.follow_ups_total ? Math.round((a.counts.follow_ups_completed / a.counts.follow_ups_total) * 100) : null;
  return (
    <Page wide>
      <PageHeader title="Analytics" subtitle="Aggregate adoption and knowledge metrics. No individual clinic's clinical details are shown." />
      <div className="mb-6 grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {Object.entries(a.counts).filter(([k]) => k !== "trained_or_beyond").map(([k, v]) => (
          <div key={k} className="card px-4 py-3"><div className="text-2xl font-semibold">{v}</div><div className="text-xs text-muted">{LABELS[k] ?? k}</div></div>
        ))}
        <div className="card px-4 py-3"><div className="text-2xl font-semibold">{followRate == null ? "—" : `${followRate}%`}</div><div className="text-xs text-muted">Follow-up completion</div></div>
        <div className="card px-4 py-3"><div className="text-2xl font-semibold">{a.timing.training_to_first_use_days == null ? "—" : `${Math.round(a.timing.training_to_first_use_days)} d`}</div><div className="text-xs text-muted">Median training → first use</div></div>
        <div className="card px-4 py-3"><div className="text-2xl font-semibold">{a.timing.first_to_second_use_days == null ? "—" : `${Math.round(a.timing.first_to_second_use_days)} d`}</div><div className="text-xs text-muted">Median first → second use</div></div>
      </div>
      <div className="grid gap-5 lg:grid-cols-2">
        <Section title="Adoption stages">
          <Bars rows={a.adoption.map((r) => ({ label: r.state.replace(/_/g, " "), value: r.n }))} />
        </Section>
        <Section title="Product usage (recorded units)">
          <Bars rows={a.usageByProduct.map((r) => ({ label: r.product, value: r.units }))} />
        </Section>
        <Section title="Common question types">
          <Bars rows={a.intents.map((r) => ({ label: r.intent.replace(/_/g, " "), value: r.n }))} />
        </Section>
        <Section title="Most cited sources">
          <Bars rows={a.topSources.map((r) => ({ label: r.title, value: r.n }))} />
        </Section>
        <Section title="Top unanswered questions">
          {a.topGaps.length ? <ol className="list-decimal space-y-1 pl-5 text-sm">{a.topGaps.map((g, i) => <li key={i}>{g.question} <span className="text-muted">({g.frequency}×)</span></li>)}</ol> : <p className="text-sm text-muted">None.</p>}
        </Section>
      </div>
    </Page>
  );
}

function Bars({ rows }: { rows: { label: string; value: number }[] }) {
  if (!rows.length) return <p className="text-sm text-muted">No data yet.</p>;
  const max = Math.max(...rows.map((r) => r.value), 1);
  return (
    <ul className="space-y-2">
      {rows.map((r) => (
        <li key={r.label} className="text-sm">
          <div className="flex justify-between gap-2"><span className="truncate">{r.label}</span><span className="font-medium tabular-nums">{r.value}</span></div>
          <div className="mt-1 h-2 rounded-full bg-canvas"><div className="h-2 rounded-full bg-brand" style={{ width: `${(r.value / max) * 100}%` }} /></div>
        </li>
      ))}
    </ul>
  );
}
