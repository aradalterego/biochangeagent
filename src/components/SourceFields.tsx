import { AUTHORITY_LEVELS, DEFAULT_AUTHORITY, SOURCE_TYPES, SOURCE_TYPE_LABELS } from "@/server/knowledge/constants";
import type { SourceRow } from "@/server/knowledge/sources";
import { isoDate } from "@/lib/format";

export function SourceFields({ s, others }: { s?: SourceRow; others?: { id: string; title: string }[] }) {
  return (
    <div className="grid gap-4 sm:grid-cols-3">
      <div className="sm:col-span-3"><label className="label">Title</label><input name="title" required defaultValue={s?.title} className="input" /></div>
      <div>
        <label className="label">Source type</label>
        <select name="source_type" defaultValue={s?.source_type ?? ""} required className="input">
          <option value="" disabled>Choose…</option>
          {SOURCE_TYPES.map((t) => <option key={t} value={t}>{SOURCE_TYPE_LABELS[t]} (default level {DEFAULT_AUTHORITY[t]})</option>)}
        </select>
      </div>
      <div>
        <label className="label">Authority level</label>
        <select name="authority_level" defaultValue={s?.authority_level ?? ""} className="input">
          <option value="">Default for type</option>
          {Object.entries(AUTHORITY_LEVELS).map(([k, v]) => <option key={k} value={k}>{k} — {v}</option>)}
        </select>
      </div>
      <div>
        <label className="label">Product</label>
        <select name="product" defaultValue={s?.product ?? ""} className="input">
          <option value="">General / all</option><option>ReGum Vet</option><option>MicroFoam</option>
        </select>
      </div>
      <div className="sm:col-span-2"><label className="label">Source URL</label><input name="source_url" type="url" defaultValue={s?.source_url ?? ""} className="input" /></div>
      <div><label className="label">Version</label><input name="version" defaultValue={s?.version ?? ""} className="input" /></div>
      <div><label className="label">Publication date</label><input name="publication_date" type="date" defaultValue={isoDate(s?.publication_date)} className="input" /></div>
      <div><label className="label">Country / market</label><input name="country_or_market" defaultValue={s?.country_or_market ?? "global"} className="input" /></div>
      <div><label className="label">Regulatory status</label><input name="regulatory_status" defaultValue={s?.regulatory_status ?? ""} className="input" /></div>
      <div>
        <label className="label">Clinical / commercial</label>
        <select name="clinical_or_commercial" defaultValue={s?.clinical_or_commercial ?? "clinical"} className="input">
          <option value="clinical">Clinical</option><option value="commercial">Commercial</option><option value="both">Both</option>
        </select>
      </div>
      <div><label className="label">Effective from</label><input name="effective_from" type="date" defaultValue={isoDate(s?.effective_from)} className="input" /></div>
      <div><label className="label">Effective until</label><input name="effective_until" type="date" defaultValue={isoDate(s?.effective_until)} className="input" /></div>
      <div className="sm:col-span-2"><label className="label">Tags (comma separated)</label><input name="tags" defaultValue={s?.tags.join(", ")} className="input" /></div>
      <div>
        <label className="label">Supersedes (older version)</label>
        <select name="supersedes_source_id" defaultValue={s?.supersedes_source_id ?? ""} className="input">
          <option value="">—</option>
          {others?.map((o) => <option key={o.id} value={o.id}>{o.title.slice(0, 70)}</option>)}
        </select>
      </div>
      <div className="sm:col-span-3"><label className="label">Notes</label><textarea name="notes" rows={2} defaultValue={s?.notes ?? ""} className="input" /></div>
    </div>
  );
}
