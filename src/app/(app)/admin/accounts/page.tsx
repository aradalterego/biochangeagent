import { requireRole } from "@/lib/auth/session";
import { sql } from "@/lib/db";
import { ROLES, ROLE_LABELS } from "@/lib/roles";
import { createClinicAction, createUserAction, resetMfaAction, setUserActiveAction, setUserPasswordAction } from "@/app/actions/admin";
import { isBioChangeStaff } from "@/lib/roles";
import { ActionForm } from "@/components/ActionForm";
import { Badge, Page, PageHeader, Section } from "@/components/ui";
import { fmtDate } from "@/lib/format";

/** Account state only — never the model's private reasoning. */
export default async function AccountsPage() {
  const me = await requireRole(["biochange_admin"]);
  const clinics = await sql<{ id: string; name: string; country: string | null; distributor: string | null; users: number; cases: number; orders: number; created_at: Date }[]>`
    SELECT c.id, c.name, c.country, d.name AS distributor, c.created_at,
      (SELECT count(*)::int FROM users u WHERE u.clinic_id = c.id) AS users,
      (SELECT count(*)::int FROM cases x WHERE x.clinic_id = c.id) AS cases,
      (SELECT count(*)::int FROM orders o WHERE o.clinic_id = c.id AND o.status NOT IN ('draft', 'cancelled')) AS orders
    FROM clinics c LEFT JOIN distributors d ON d.id = c.distributor_id ORDER BY c.name`;
  const users = await sql<{ id: string; name: string; email: string; role: keyof typeof ROLE_LABELS; clinic: string | null; active: boolean; last_active_at: Date | null; last_login_at: Date | null; state: string | null; conversations: number; mfa: boolean; sign_in: string | null }[]>`
    SELECT u.id, u.name, u.email, u.role, c.name AS clinic, u.active, u.last_active_at, u.last_login_at, a.state,
      u.totp_enabled_at IS NOT NULL AS mfa, u.auth_provider AS sign_in,
      (SELECT count(*)::int FROM conversations cv WHERE cv.user_id = u.id) AS conversations
    FROM users u LEFT JOIN clinics c ON c.id = u.clinic_id LEFT JOIN adoption_states a ON a.user_id = u.id
    ORDER BY u.role, u.name`;
  const distributors = await sql<{ id: string; name: string }[]>`SELECT id, name FROM distributors WHERE active ORDER BY name`;
  return (
    <Page wide>
      <PageHeader title="Users & Clinics" subtitle="Invitations, sign-in state and activity." />
      <Section title="Users">
        <div className="overflow-x-auto">
          <table className="table">
            <thead><tr><th>Name</th><th>Role</th><th>Clinic</th><th>Sign-in</th><th>Conversations</th><th>Last active</th><th></th></tr></thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id}>
                  <td>{u.name}<div className="text-xs text-muted">{u.email}</div></td>
                  <td>{ROLE_LABELS[u.role]}</td>
                  <td>{u.clinic ?? "—"}</td>
                  <td>
                    {u.last_login_at ? <span className="text-xs">{fmtDate(u.last_login_at)}</span> : <Badge tone="warn">invited</Badge>}
                    {isBioChangeStaff(u.role) && <div className="mt-0.5"><Badge tone={u.mfa ? "ok" : "warn"}>{u.mfa ? "2-step on" : "2-step not set up"}</Badge></div>}
                  </td>
                  <td>{u.conversations}</td>
                  <td>{fmtDate(u.last_active_at)}</td>
                  <td className="space-y-1">
                    <ActionForm action={setUserActiveAction.bind(null, u.id, !u.active)} submitLabel={u.active ? "Deactivate" : "Activate"} submitClassName={u.active ? "btn-danger" : "btn-secondary"} />
                    {u.id !== me.id && (<details>
                      <summary className="cursor-pointer text-xs text-brand hover:underline">Set password</summary>
                      <ActionForm action={setUserPasswordAction.bind(null, u.id)} submitLabel="Set password" submitClassName="btn-secondary" resetOnSuccess>
                        <input name="password" type="password" autoComplete="new-password" required minLength={10} placeholder="At least 10 characters, letters and numbers" aria-label={`New password for ${u.email}`} className="input mt-1" />
                      </ActionForm>
                    </details>)}
                    {u.mfa && <ActionForm action={resetMfaAction.bind(null, u.id)} submitLabel="Reset 2-step" submitClassName="btn-secondary" confirm="Reset this user's two-step verification? They will enrol a new authenticator at next sign-in." />}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>
      <Section title="Clinics">
        <table className="table">
          <thead><tr><th>Clinic</th><th>Country</th><th>Distributor</th><th>Users</th><th>Cases</th><th>Orders</th><th>Created</th></tr></thead>
          <tbody>
            {clinics.map((c) => (
              <tr key={c.id}><td>{c.name}</td><td>{c.country ?? "—"}</td><td>{c.distributor ?? "—"}</td><td>{c.users}</td><td>{c.cases}</td><td>{c.orders}</td><td>{fmtDate(c.created_at)}</td></tr>
            ))}
          </tbody>
        </table>
      </Section>
      <div className="grid gap-5 lg:grid-cols-2">
        <Section title="Create clinic">
          <ActionForm action={createClinicAction} submitLabel="Create clinic" resetOnSuccess>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="sm:col-span-2"><label className="label">Name</label><input name="name" required className="input" /></div>
              <div><label className="label">Country</label><input name="country" className="input" /></div>
              <div><label className="label">Timezone</label><input name="timezone" placeholder="Europe/London" className="input" /></div>
              <div><label className="label">Distributor</label><select name="distributor_id" className="input"><option value="">—</option>{distributors.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></div>
              <div><label className="label">Dental cases / month (est.)</label><input name="estimated_dental_cases_per_month" type="number" min={0} className="input" /></div>
            </div>
          </ActionForm>
        </Section>
        <Section title="Create user">
          <ActionForm action={createUserAction} submitLabel="Create user" resetOnSuccess>
            <div className="grid gap-3 sm:grid-cols-2">
              <div><label className="label">Name</label><input name="name" required className="input" /></div>
              <div><label className="label">Email</label><input name="email" type="email" required className="input" /></div>
              <div><label className="label">Role</label><select name="role" className="input">{ROLES.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}</select></div>
              <div><label className="label">Clinic</label><select name="clinic_id" className="input"><option value="">—</option>{clinics.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div>
              <div><label className="label">Title</label><input name="professional_title" className="input" /></div>
              <div><label className="label">Country</label><input name="country" className="input" /></div>
              <div><label className="label">Timezone</label><input name="timezone" placeholder="UTC" className="input" /></div>
              <div><label className="label">Password (staff only, optional)</label><input name="password" type="password" autoComplete="new-password" className="input" placeholder="Leave empty for email sign-in" /></div>
            </div>
            <label className="mt-3 flex items-center gap-2 text-sm"><input type="checkbox" name="send_invite" defaultChecked /> Email an invitation</label>
            <p className="mt-1 text-xs text-muted">Veterinarians sign in with a one-time email link (or Google). Only invited, active users can sign in.</p>
          </ActionForm>
        </Section>
      </div>
    </Page>
  );
}
