import { CASE_STATUSES, type CaseRow } from "@/server/domain/cases";
import { isoDate } from "@/lib/format";

export function CaseFields({ c, products }: { c?: CaseRow; products: { name: string }[] }) {
  const v = (x: unknown) => (x == null ? undefined : String(x));
  return (
    <div className="grid gap-4 sm:grid-cols-3">
      <Input name="internal_patient_identifier" label="Patient reference (no owner data)" defaultValue={v(c?.internal_patient_identifier)} />
      <Input name="species" label="Species" defaultValue={v(c?.species) ?? "dog"} />
      <Input name="breed" label="Breed" defaultValue={v(c?.breed)} />
      <Input name="age" label="Age" defaultValue={v(c?.age)} />
      <Input name="tooth" label="Tooth (Triadan)" defaultValue={v(c?.tooth)} />
      <Input name="pocket_depth_mm" label="Pocket depth (mm)" type="number" step="0.5" defaultValue={v(c?.pocket_depth_mm)} />
      <Input name="defect_type" label="Defect type" defaultValue={v(c?.defect_type)} />
      <Input name="furcation" label="Furcation" defaultValue={v(c?.furcation)} />
      <Input name="procedure_type" label="Procedure" defaultValue={v(c?.procedure_type)} />
      <div>
        <label className="label">Product</label>
        <select name="product" defaultValue={c?.product_name ?? ""} className="input">
          <option value="">—</option>
          {products.map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}
        </select>
      </div>
      <Input name="treatment_date" label="Treatment date" type="date" defaultValue={isoDate(c?.treatment_date)} />
      <div>
        <label className="label">Status</label>
        <select name="status" defaultValue={c?.status ?? ""} className="input">
          <option value="">(automatic)</option>
          {CASE_STATUSES.map((s) => <option key={s} value={s}>{s.replace(/_/g, " ")}</option>)}
        </select>
      </div>
      <div className="sm:col-span-3"><Input name="condition_summary" label="Condition summary" defaultValue={v(c?.condition_summary)} /></div>
      <div className="sm:col-span-3"><Input name="treatment_goal" label="Treatment goal" defaultValue={v(c?.treatment_goal)} /></div>
      <div className="sm:col-span-3">
        <label className="label">Baseline notes</label>
        <textarea name="baseline_notes" defaultValue={v(c?.baseline_notes)} rows={2} className="input" />
      </div>
      {!c && <Input name="follow_up_date" label="Follow-up date (optional)" type="date" />}
    </div>
  );
}

function Input({ label, ...props }: { label: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <div>
      <label className="label">{label}</label>
      <input className="input" {...props} />
    </div>
  );
}
