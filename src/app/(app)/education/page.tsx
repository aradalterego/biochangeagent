import { requireUser } from "@/lib/auth/session";
import { actorFromSession } from "@/lib/authz";
import { listEducation } from "@/server/domain/education";
import { getUserProfile } from "@/server/domain/profile";
import { trainingAction } from "@/app/actions/account";
import { ActionForm } from "@/components/ActionForm";
import { Badge, Empty, Page, PageHeader } from "@/components/ui";

const TYPE_LABEL: Record<string, string> = {
  product_education: "Product education", tutorial: "Tutorial", webinar: "Webinar", study: "Study", case_study: "Case study", training_course: "Training", faq: "FAQ",
};

export default async function EducationPage({ searchParams }: { searchParams: Promise<{ product?: string; q?: string }> }) {
  const user = await requireUser();
  const sp = await searchParams;
  const [resources, profile] = await Promise.all([
    listEducation(actorFromSession(user), { product: sp.product, query: sp.q }),
    getUserProfile(user.id),
  ]);
  // Light personalisation: training not yet completed first, then intro material for products not yet used.
  const sorted = [...resources].sort((a, b) => score(b, profile) - score(a, profile));
  return (
    <Page wide>
      <PageHeader title="Education" subtitle="Product education, tutorials, studies and case studies." />
      <form className="mb-5 flex flex-wrap gap-2">
        <input name="q" defaultValue={sp.q} placeholder="Search education…" className="input max-w-xs" />
        <select name="product" defaultValue={sp.product ?? ""} className="input w-44">
          <option value="">All products</option><option>ReGum Vet</option><option>MicroFoam</option>
        </select>
        <button className="btn-secondary">Filter</button>
      </form>
      {sorted.length ? (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {sorted.map((r) => (
            <div key={r.id} className="card flex flex-col p-4">
              <div className="mb-2 flex flex-wrap gap-1.5">
                <Badge tone="brand">{TYPE_LABEL[r.resource_type] ?? r.resource_type}</Badge>
                {r.product && <Badge>{r.product}</Badge>}
                {r.level && <Badge>{r.level}</Badge>}
                {r.completed ? <Badge tone="ok">Completed</Badge> : r.opened ? <Badge tone="warn">Opened</Badge> : null}
              </div>
              <div className="font-medium">{r.title}</div>
              {r.description && <p className="mt-1 flex-1 text-sm text-muted">{r.description}</p>}
              <div className="mt-3 flex flex-wrap items-center gap-2">
                {r.url && <a href={r.url} target="_blank" rel="noreferrer" className="btn-secondary">Open</a>}
                {r.source_id && <a href={`/sources/${r.source_id}`} className="btn-secondary">View source</a>}
                {r.counts_as_training && !r.completed && <ActionForm action={trainingAction.bind(null, r.id, true)} submitLabel="Mark completed" submitClassName="btn-secondary" />}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <Empty>No education resources match.</Empty>
      )}
    </Page>
  );
}

function score(r: { counts_as_training: boolean; completed: boolean; product: string | null; level: string | null }, p: { regum_training_status: string | null; microfoam_training_status: string | null }) {
  let s = 0;
  if (r.counts_as_training && !r.completed) s += 3;
  if (r.product === "ReGum Vet" && p.regum_training_status !== "completed" && r.level === "intro") s += 2;
  if (r.product === "MicroFoam" && p.microfoam_training_status !== "completed" && r.level === "intro") s += 2;
  if (r.completed) s -= 2;
  return s;
}
