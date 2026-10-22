"use client";

import { useState } from "react";

type Option = { value: string; label: string };
export interface RuleDefaults {
  name?: string; reminder_type?: string; trigger_event?: string; product_id?: string | null; delay_days?: number; repeat_every_days?: number | null;
  max_sends?: number; audience?: string; template_id?: string | null; subject?: string; body?: string; offer_discount?: boolean;
  discount_percent?: number | null; offer_valid_days?: number; applies_from?: string; active?: boolean;
}

const PRESETS = [7, 14, 30, 60, 90, 180];

/** Fields of a reminder rule. Choosing a template fills subject and body; a feedback-offer rule always carries a discount. */
export function RuleFields({ d = {}, types, triggers, audiences, products, templates, mergeTags }: {
  d?: RuleDefaults; types: Option[]; triggers: Option[]; audiences: Option[]; products: Option[];
  templates: { id: string; name: string; subject: string; body: string }[]; mergeTags: readonly string[];
}) {
  const [type, setType] = useState(d.reminder_type ?? "check_in");
  const [delay, setDelay] = useState(String(d.delay_days ?? 30));
  const [maxSends, setMaxSends] = useState(String(d.max_sends ?? 1));
  const [offer, setOffer] = useState(Boolean(d.offer_discount));
  const [subject, setSubject] = useState(d.subject ?? "");
  const [body, setBody] = useState(d.body ?? "");
  const offerOn = offer || type === "feedback_offer";
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <div className="sm:col-span-2 lg:col-span-1"><label className="label">Rule name</label><input name="name" required defaultValue={d.name} className="input" placeholder="e.g. Check-in 1 month after purchase" /></div>
        <div><label className="label">Reminder type</label><select name="reminder_type" value={type} onChange={(e) => setType(e.target.value)} className="input">{types.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select></div>
        <div><label className="label">Trigger event</label><select name="trigger_event" defaultValue={d.trigger_event ?? "purchase"} className="input">{triggers.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select></div>
        <div><label className="label">Product</label><select name="product_id" defaultValue={d.product_id ?? ""} className="input"><option value="">Any product</option>{products.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select></div>
        <div><label className="label">Audience</label><select name="audience" defaultValue={d.audience ?? "all"} className="input">{audiences.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select></div>
        <div><label className="label">Applies to events from</label><input type="date" name="applies_from" defaultValue={d.applies_from ?? ""} className="input" title="Events before this date are ignored (default: today)" /></div>
      </div>

      <fieldset className="rounded-lg border border-line p-3">
        <legend className="px-1 text-xs font-semibold text-muted">Interval</legend>
        <div className="grid gap-3 sm:grid-cols-3">
          <div>
            <label className="label">Send after (days)</label>
            <input name="delay_days" type="number" min={0} max={1095} required value={delay} onChange={(e) => setDelay(e.target.value)} className="input" />
            <div className="mt-1 flex flex-wrap gap-1">
              {PRESETS.map((p) => (
                <button type="button" key={p} onClick={() => setDelay(String(p))} className={`rounded border px-1.5 py-0.5 text-[11px] ${delay === String(p) ? "border-brand text-brand" : "border-line text-muted hover:text-ink"}`}>
                  {p === 7 ? "1 week" : p === 14 ? "2 weeks" : p === 30 ? "1 month" : p === 60 ? "2 months" : p === 90 ? "3 months" : "6 months"}
                </button>
              ))}
            </div>
          </div>
          <div><label className="label">Number of emails</label><input name="max_sends" type="number" min={1} max={24} value={maxSends} onChange={(e) => setMaxSends(e.target.value)} className="input" /></div>
          <div>
            <label className="label">Then repeat every (days)</label>
            <input name="repeat_every_days" type="number" min={1} max={1095} defaultValue={d.repeat_every_days ?? ""} disabled={Number(maxSends) <= 1} className="input disabled:opacity-50" />
          </div>
        </div>
      </fieldset>

      <fieldset className="rounded-lg border border-line p-3">
        <legend className="px-1 text-xs font-semibold text-muted">Email</legend>
        {templates.length > 0 && (
          <div className="mb-3">
            <label className="label">Start from a template</label>
            <select name="template_id" defaultValue={d.template_id ?? ""} className="input" onChange={(e) => {
              const t = templates.find((x) => x.id === e.target.value);
              if (t) { setSubject(t.subject); setBody(t.body); }
            }}>
              <option value="">—</option>
              {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </div>
        )}
        <div className="space-y-3">
          <div><label className="label">Subject</label><input name="subject" value={subject} onChange={(e) => setSubject(e.target.value)} required maxLength={200} className="input" /></div>
          <div><label className="label">Body</label><textarea name="body" value={body} onChange={(e) => setBody(e.target.value)} required rows={8} className="input font-mono text-xs" /></div>
          <p className="text-xs text-muted">Merge tags: {mergeTags.map((t) => <code key={t} className="mr-1.5">{`{{${t}}}`}</code>)}</p>
        </div>
      </fieldset>

      <fieldset className="rounded-lg border border-line p-3">
        <legend className="px-1 text-xs font-semibold text-muted">Feedback for a discount</legend>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="offer_discount" checked={offerOn} disabled={type === "feedback_offer"} onChange={(e) => setOffer(e.target.checked)} />
          Offer a discount on the next order to a veterinarian who uses the product now and gives short feedback
        </label>
        {type === "feedback_offer" && <input type="hidden" name="offer_discount" value="on" />}
        {offerOn && (
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <div><label className="label">Discount (%)</label><input name="discount_percent" type="number" min={1} max={100} required defaultValue={d.discount_percent ?? 10} className="input" /></div>
            <div><label className="label">Offer valid for (days)</label><input name="offer_valid_days" type="number" min={1} max={365} defaultValue={d.offer_valid_days ?? 30} className="input" /></div>
          </div>
        )}
        <p className="mt-2 text-xs text-muted">The email gets a personal link (<code>{"{{feedback_link}}"}</code>, added automatically if missing). The veterinarian signs in, answers 3 short questions and, if they use the product now, receives a discount code on screen and by email.</p>
      </fieldset>

      <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="active" defaultChecked={d.active ?? true} /> Active</label>
    </div>
  );
}
