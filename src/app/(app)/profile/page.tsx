import { requireUser } from "@/lib/auth/session";
import { getUserProfile } from "@/server/domain/profile";
import { getMemories } from "@/server/domain/memory";
import { forgetMemoryAction, updateProfileAction } from "@/app/actions/account";
import { ActionForm } from "@/components/ActionForm";
import { Page, PageHeader, Section } from "@/components/ui";
import { fmtDate, titleCase } from "@/lib/format";

export default async function ProfilePage() {
  const user = await requireUser();
  const [p, memories] = await Promise.all([getUserProfile(user.id), getMemories(user.id, 50)]);
  const sel = (name: string, value: string | null, options: string[]) => (
    <select name={name} defaultValue={value ?? ""} className="input">
      <option value="">—</option>
      {options.map((o) => <option key={o} value={o}>{titleCase(o)}</option>)}
    </select>
  );
  return (
    <Page>
      <PageHeader title="Profile & memory" subtitle="What the companion knows about you. You can correct it or make it forget." />
      <Section title="Professional profile">
        <ActionForm action={updateProfileAction}>
          <div className="grid gap-4 sm:grid-cols-3">
            <div><label className="label">Title</label><input name="professional_title" defaultValue={p.professional_title ?? ""} className="input" /></div>
            <div><label className="label">Specialty</label><input name="specialty" defaultValue={p.specialty ?? ""} className="input" /></div>
            <div><label className="label">Years in practice</label><input name="years_in_practice" type="number" min={0} defaultValue={p.years_in_practice ?? ""} className="input" /></div>
            <div><label className="label">Dental experience</label>{sel("dental_experience_level", p.dental_experience_level, ["none", "basic", "intermediate", "advanced", "specialist"])}</div>
            <div><label className="label">Regenerative dentistry</label>{sel("regenerative_dentistry_experience", p.regenerative_dentistry_experience, ["none", "some", "experienced"])}</div>
            <div><label className="label">Answer depth</label>{sel("preferred_answer_depth", p.preferred_answer_depth, ["concise", "balanced", "detailed"])}</div>
            <div><label className="label">Timezone</label><input name="timezone" defaultValue={p.timezone} className="input" /></div>
            <div><div className="label">ReGum training</div><div className="py-2 text-sm">{titleCase(p.regum_training_status)}</div></div>
            <div><div className="label">MicroFoam training</div><div className="py-2 text-sm">{titleCase(p.microfoam_training_status)}</div></div>
          </div>
        </ActionForm>
      </Section>
      <Section title="Long-term memory">
        {memories.length ? (
          <ul className="divide-y divide-line">
            {memories.map((m) => (
              <li key={m.id} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                <span>{m.content} <span className="text-xs text-muted">· {m.memory_type} · {fmtDate(m.updated_at)}</span></span>
                <ActionForm action={forgetMemoryAction.bind(null, m.id)} submitLabel="Forget" submitClassName="btn-secondary" />
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted">Nothing remembered yet.</p>
        )}
      </Section>
    </Page>
  );
}
