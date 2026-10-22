"use client";

import { useMemo, useState } from "react";

type Vet = { id: string; name: string; email: string; country: string | null; is_customer: boolean };

/** Recipients (chosen veterinarians or a segment), template picker and the message itself. */
export function ComposeFields({ vets, countries, products, templates, mergeTags, sender }: {
  vets: Vet[]; countries: string[]; products: { id: string; name: string }[];
  templates: { id: string; name: string; subject: string; body: string }[]; mergeTags: readonly string[]; sender: string;
}) {
  const [audience, setAudience] = useState("selected");
  const [filter, setFilter] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [saveTemplate, setSaveTemplate] = useState(false);
  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return q ? vets.filter((v) => `${v.name} ${v.email} ${v.country ?? ""}`.toLowerCase().includes(q)) : vets;
  }, [vets, filter]);
  const toggle = (id: string) => setPicked((s) => {
    const n = new Set(s);
    if (n.has(id)) n.delete(id); else n.add(id);
    return n;
  });
  return (
    <div className="grid gap-5 lg:grid-cols-5">
      <div className="lg:col-span-2">
        <label className="label">Recipients</label>
        <select name="audience" value={audience} onChange={(e) => setAudience(e.target.value)} className="input">
          <option value="selected">Chosen veterinarians</option>
          <option value="all">All veterinarians</option>
          <option value="customers">Customers</option>
          <option value="non_customers">Non-customers</option>
        </select>
        {audience === "selected" ? (
          <div className="mt-2 rounded-lg border border-line">
            <div className="flex items-center gap-2 border-b border-line p-2">
              <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Search name, email, country…" className="input py-1 text-xs" aria-label="Search veterinarians" />
              <button type="button" className="whitespace-nowrap text-xs text-brand hover:underline" onClick={() => setPicked(new Set([...picked, ...shown.map((v) => v.id)]))}>Select shown</button>
              <button type="button" className="text-xs text-muted hover:underline" onClick={() => setPicked(new Set())}>Clear</button>
            </div>
            <ul className="max-h-72 overflow-y-auto p-1 text-sm">
              {shown.map((v) => (
                <li key={v.id}>
                  <label className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 hover:bg-canvas">
                    <input type="checkbox" name="user_ids" value={v.id} checked={picked.has(v.id)} onChange={() => toggle(v.id)} />
                    <span className="min-w-0 flex-1 truncate">{v.name} <span className="text-xs text-muted">{v.email}</span></span>
                    <span className="text-[11px] text-muted">{v.country ?? ""}{v.is_customer ? " · customer" : ""}</span>
                  </label>
                </li>
              ))}
              {!shown.length && <li className="px-2 py-3 text-xs text-muted">No veterinarians match.</li>}
            </ul>
            <div className="border-t border-line px-2 py-1 text-xs text-muted">{picked.size} selected</div>
          </div>
        ) : (
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            <select name="country" className="input" defaultValue=""><option value="">All countries</option>{countries.map((c) => <option key={c} value={c}>{c}</option>)}</select>
            <select name="product_id" className="input" defaultValue=""><option value="">Any product</option>{products.map((p) => <option key={p.id} value={p.id}>Bought / used {p.name}</option>)}</select>
          </div>
        )}
      </div>
      <div className="space-y-3 lg:col-span-3">
        <div className="text-xs text-muted">From: <span className="font-medium text-ink">{sender}</span></div>
        {templates.length > 0 && (
          <div>
            <label className="label">Template</label>
            <select name="template_id" defaultValue="" className="input" onChange={(e) => {
              const t = templates.find((x) => x.id === e.target.value);
              if (t) { setSubject(t.subject); setBody(t.body); }
            }}>
              <option value="">Plain email</option>
              {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </div>
        )}
        <div><label className="label">Subject</label><input name="subject" value={subject} onChange={(e) => setSubject(e.target.value)} required maxLength={200} className="input" /></div>
        <div><label className="label">Message</label><textarea name="body" value={body} onChange={(e) => setBody(e.target.value)} required rows={12} className="input" /></div>
        <p className="text-xs text-muted">Personalise with {mergeTags.filter((t) => ["first_name", "name", "title", "country", "app_url"].includes(t)).map((t) => <code key={t} className="mr-1.5">{`{{${t}}}`}</code>)}</p>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="save_as_template" checked={saveTemplate} onChange={(e) => setSaveTemplate(e.target.checked)} /> Also save as a template</label>
        {saveTemplate && <input name="template_name" placeholder="Template name" className="input" />}
      </div>
    </div>
  );
}
