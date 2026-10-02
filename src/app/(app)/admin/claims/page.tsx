import { requireRole } from "@/lib/auth/session";
import { actorFromSession } from "@/lib/authz";
import { sql } from "@/lib/db";
import { listClaims } from "@/server/knowledge/claims";
import { CLAIM_TYPES } from "@/server/knowledge/constants";
import { saveClaimAction } from "@/app/actions/admin";
import { ActionForm } from "@/components/ActionForm";
import { Badge, Page, PageHeader, Section, statusTone } from "@/components/ui";

export default async function ClaimsPage() {
  const user = await requireRole(["biochange_admin", "biochange_medical"]);
  const claims = await listClaims(actorFromSession(user));
  const sources = await sql<{ id: string; title: string }[]>`SELECT id, title FROM knowledge_sources WHERE status = 'approved' ORDER BY authority_level, title`;
  const form = (c?: (typeof claims)[number]) => (
    <ActionForm action={saveClaimAction} submitLabel={c ? "Save" : "Add claim"} resetOnSuccess={!c}>
      {c && <input type="hidden" name="id" value={c.id} />}
      <div className="grid gap-3 sm:grid-cols-4">
        <div className="sm:col-span-4"><label className="label">Claim wording</label><textarea name="claim" rows={2} required defaultValue={c?.claim} className="input" /></div>
        <div><label className="label">Product</label><select name="product" defaultValue={c?.product ?? "ReGum Vet"} className="input"><option>ReGum Vet</option><option>MicroFoam</option></select></div>
        <div><label className="label">Type</label><select name="claim_type" defaultValue={c?.claim_type ?? "mechanism"} className="input">{CLAIM_TYPES.map((t) => <option key={t}>{t}</option>)}</select></div>
        <div><label className="label">Market</label><input name="market" defaultValue={c?.market ?? "global"} className="input" /></div>
        <div><label className="label">Status</label><select name="status" defaultValue={c?.status ?? "draft"} className="input"><option>draft</option><option>approved</option><option>retired</option></select></div>
        <div className="sm:col-span-2"><label className="label">Supporting source (approved)</label><select name="source_id" defaultValue={c?.source_id ?? ""} className="input"><option value="">—</option>{sources.map((s) => <option key={s.id} value={s.id}>{s.title.slice(0, 80)}</option>)}</select></div>
        <div><label className="label">Allowed context</label><input name="allowed_context" defaultValue={c?.allowed_context ?? ""} className="input" /></div>
        <div><label className="label">Restricted wording</label><input name="restricted_wording" defaultValue={c?.restricted_wording ?? ""} className="input" /></div>
      </div>
    </ActionForm>
  );
  return (
    <Page wide>
      <PageHeader title="Approved Claims" subtitle="The agent formulates product claims preferentially from approved entries here. Approved claims must cite an approved source." />
      <Section title="Add claim">{form()}</Section>
      {claims.map((c) => (
        <Section key={c.id} title={`${c.product} · ${c.claim_type}`} actions={<Badge tone={statusTone(c.status)}>{c.status}</Badge>}>
          <p className="mb-2 text-sm">{c.claim}</p>
          <p className="mb-3 text-xs text-muted">Source: {c.source_title ?? "—"}</p>
          <details><summary className="cursor-pointer text-sm text-brand">Edit</summary><div className="mt-3">{form(c)}</div></details>
        </Section>
      ))}
    </Page>
  );
}
