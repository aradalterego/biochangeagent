import { requireRole } from "@/lib/auth/session";
import { actorFromSession } from "@/lib/authz";
import { listPolicyVersions } from "@/server/domain/agentPolicy";
import { listProducts } from "@/server/domain/products";
import { savePolicyAction } from "@/app/actions/admin";
import { ActionForm } from "@/components/ActionForm";
import { Page, PageHeader, Section } from "@/components/ui";
import { fmtDateTime } from "@/lib/format";

/**
 * Agent boundaries managed by BioChange. This page never shows the system prompt, keys or
 * infrastructure settings: only the business policy that is added to the agent's instructions.
 */
export default async function AgentPolicyPage() {
  const user = await requireRole(["biochange_admin", "biochange_medical"]);
  const [versions, products] = await Promise.all([listPolicyVersions(actorFromSession(user)), listProducts()]);
  const p = versions[0];
  const families = [...new Set(products.map((x) => x.product_family))];
  return (
    <Page>
      <PageHeader title="Agent policy" subtitle="What the agent may and may not answer, and who it refers veterinarians to. Built-in safety rules always apply first." />
      <Section title="Current policy">
        <ActionForm action={savePolicyAction} submitLabel="Save policy">
          <div className="space-y-4">
            <div>
              <div className="label">Products in scope</div>
              <div className="flex flex-wrap gap-4 text-sm">
                {families.map((f) => (
                  <label key={f} className="flex items-center gap-2">
                    <input type="checkbox" name="product_scope" value={f} defaultChecked={p ? p.product_scope.includes(f) : true} /> {f}
                  </label>
                ))}
              </div>
            </div>
            <div>
              <label className="label">Topics the agent may help with (one per line)</label>
              <textarea name="allowed_topics" rows={4} defaultValue={p?.allowed_topics ?? ""} className="input" placeholder={"Product handling and preparation\nCase selection according to the IFU\nPublished evidence for BioChange products"} />
            </div>
            <div>
              <label className="label">Topics the agent must not answer (one per line)</label>
              <textarea name="disallowed_topics" rows={4} defaultValue={p?.disallowed_topics ?? ""} className="input" placeholder={"Off-label use\nPricing and discounts\nHuman dental use"} />
            </div>
            <div>
              <label className="label">Out-of-scope reply (the gist the agent should convey)</label>
              <textarea name="out_of_scope_message" rows={2} maxLength={600} defaultValue={p?.out_of_scope_message ?? ""} className="input" placeholder="That is outside what I can help with. Please contact BioChange's veterinary team." />
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <div><label className="label">Escalation contact name</label><input name="escalation_contact_name" maxLength={120} defaultValue={p?.escalation_contact_name ?? ""} className="input" /></div>
              <div><label className="label">Email</label><input name="escalation_contact_email" type="email" defaultValue={p?.escalation_contact_email ?? ""} className="input" /></div>
              <div><label className="label">Phone</label><input name="escalation_contact_phone" maxLength={40} defaultValue={p?.escalation_contact_phone ?? ""} className="input" /></div>
            </div>
          </div>
        </ActionForm>
      </Section>
      <Section title="History">
        {versions.length ? (
          <ul className="space-y-1 text-sm">
            {versions.map((v, i) => (
              <li key={v.id}>Version {v.id}{i === 0 ? " (active)" : ""} · {fmtDateTime(v.created_at, user.timezone)} · {v.created_by_name ?? "—"}</li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted">No policy saved yet. The agent follows its built-in rules only.</p>
        )}
      </Section>
    </Page>
  );
}
