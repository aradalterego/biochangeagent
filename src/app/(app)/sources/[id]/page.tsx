import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth/session";
import { actorFromSession, NotFoundError } from "@/lib/authz";
import { sql } from "@/lib/db";
import { getSource } from "@/server/knowledge/sources";
import { isUuid } from "@/server/domain/cases";
import { AUTHORITY_LEVELS, SOURCE_TYPE_LABELS, type SourceType } from "@/server/knowledge/constants";
import { Badge, Field, Page, PageHeader, Section } from "@/components/ui";
import { fmtDate } from "@/lib/format";

/** "View source": the supporting approved source and the exact passage that was cited. */
export default async function SourcePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ chunk?: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  const { chunk } = await searchParams;
  if (!isUuid(id)) notFound();
  let s;
  try {
    s = await getSource(actorFromSession(user), id);
  } catch (e) {
    if (e instanceof NotFoundError) notFound();
    throw e;
  }
  const chunks = await sql<{ id: string; content: string; section: string | null; page: number | null }[]>`
    SELECT id, content, section, page FROM knowledge_chunks WHERE source_id = ${id} ORDER BY chunk_index`;
  const study = s.study as Record<string, string | number | null> | null;
  return (
    <Page>
      <PageHeader
        title={s.title}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <Badge tone="brand">{SOURCE_TYPE_LABELS[s.source_type as SourceType]}</Badge>
            <Badge>Authority level {s.authority_level}: {AUTHORITY_LEVELS[s.authority_level]}</Badge>
            {s.status !== "approved" && <Badge tone="warn">{s.status.replace("_", " ")}</Badge>}
            {s.tags.includes("demo-mock") && <Badge tone="danger">DEMO MOCK — not clinical guidance</Badge>}
          </span>
        }
      />
      <Section title="Source details">
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Product">{s.product}</Field>
          <Field label="Version">{s.version}</Field>
          <Field label="Market">{s.country_or_market}</Field>
          <Field label="Published">{fmtDate(s.publication_date)}</Field>
          <Field label="Last reviewed">{fmtDate(s.last_reviewed_at)}</Field>
          <Field label="Original">{s.source_url ? <a className="text-brand hover:underline" href={s.source_url} target="_blank" rel="noreferrer">Open original</a> : null}</Field>
        </div>
      </Section>
      {study && (
        <Section title="Study summary">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Authors">{study.authors}</Field>
            <Field label="Journal / year">{`${study.journal ?? ""} ${study.year ?? ""}`}</Field>
            <Field label="Design">{study.study_design}</Field>
            <Field label="Sample">{study.sample_size}</Field>
            <Field label="Intervention">{study.intervention}</Field>
            <Field label="Control">{study.control}</Field>
            <Field label="Outcomes">{study.outcomes}</Field>
            <Field label="Limitations">{study.limitations}</Field>
            <Field label="Funding / conflicts">{study.funding_conflicts}</Field>
          </div>
        </Section>
      )}
      <Section title="Indexed content">
        {chunks.length ? (
          <div className="space-y-3">
            {chunks.map((c) => (
              <div key={c.id} id={c.id} className={`rounded-lg border px-4 py-3 text-sm ${c.id === chunk ? "border-brand bg-brand-soft/60" : "border-line"}`}>
                {(c.section || c.page != null) && <div className="mb-1 text-xs font-medium text-muted">{c.section}{c.page != null ? ` · page ${c.page}` : ""}{c.id === chunk ? " · cited passage" : ""}</div>}
                <div className="whitespace-pre-wrap">{c.content}</div>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted">This source has no indexed content.</p>
        )}
      </Section>
    </Page>
  );
}
