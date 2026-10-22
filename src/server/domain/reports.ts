import "server-only";
import { sql } from "@/lib/db";
import { audit } from "@/lib/audit";
import { assertBioChangeReader, type Actor } from "@/lib/authz";
import { isUuid } from "./cases";
import { csvCell, exportCasesCsv, exportVetsCsv, filtersFromParams, vetFiltersFromParams } from "./dashboard";

/**
 * Downloadable reports for Admin. Every report filters by product, country and period;
 * cases and veterinarians reuse the dashboard queries so the numbers match the screens.
 */

export const REPORT_TYPES = ["cases", "vets", "offers", "downloads", "emails"] as const;
export type ReportType = (typeof REPORT_TYPES)[number];
export const REPORT_LABELS: Record<ReportType, { title: string; description: string; dates: string }> = {
  cases: { title: "Cases", description: "Every case with clinic, veterinarian, product, follow-up state, pocket depths and feedback.", dates: "treatment date" },
  vets: { title: "Veterinarians", description: "Veterinarians with title, country, customer status, cases, follow-ups, feedback, purchases and agent usage questions.", dates: "activity" },
  offers: { title: "Feedback & discounts", description: "Feedback-for-discount offers: answers, ratings and discount codes issued.", dates: "offer sent" },
  downloads: { title: "Marketing downloads", description: "Which veterinarian downloaded which marketing material, and when.", dates: "download" },
  emails: { title: "Emails sent", description: "Reminder-rule emails and emails written in Admin, with delivery status.", dates: "email created" },
};

type Params = Record<string, string | string[] | undefined>;

function common(sp: Params) {
  const one = (k: string) => (typeof sp[k] === "string" && (sp[k] as string).trim() ? (sp[k] as string).trim() : null);
  const date = (k: string) => {
    const v = one(k);
    return v && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v)) ? v : null;
  };
  return { productId: isUuid(one("product")) ? one("product") : null, country: one("country")?.slice(0, 100) ?? null, from: date("from"), to: date("to") };
}

function toCsv<T>(rows: T[], columns: [string, (r: T) => unknown][]): string {
  const lines = [columns.map(([h]) => h).join(",")];
  for (const r of rows) lines.push(columns.map(([, get]) => csvCell(get(r))).join(","));
  return `${lines.join("\r\n")}\r\n`;
}

const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

export async function buildReport(actor: Actor, type: ReportType, sp: Params): Promise<{ csv: string; rows: number }> {
  assertBioChangeReader(actor);
  if (type === "cases") return exportCasesCsv(actor, filtersFromParams(sp));
  if (type === "vets") return exportVetsCsv(actor, vetFiltersFromParams(sp));
  const f = common(sp);
  const vetCountry = sql`coalesce(u.country, c.country)`;
  let csv: string;
  let rows: number;
  if (type === "offers") {
    const data = await sql<{ created_at: Date; vet: string; email: string; country: string | null; product: string | null; rule: string | null; discount_percent: number; status: string; using_product: boolean | null; rating: number | null; comment: string | null; discount_code: string | null; completed_at: Date | null; expires_at: Date }[]>`
      SELECT o.created_at, u.name AS vet, u.email, ${vetCountry} AS country, p.product_family AS product, r.name AS rule, o.discount_percent, o.status,
             o.using_product, o.rating, o.comment, o.discount_code, o.completed_at, o.expires_at
      FROM feedback_offers o JOIN users u ON u.id = o.user_id LEFT JOIN clinics c ON c.id = u.clinic_id
      LEFT JOIN products p ON p.id = o.product_id LEFT JOIN reminder_rules r ON r.id = o.rule_id
      WHERE (${f.productId}::uuid IS NULL OR o.product_id = ${f.productId}) AND (${f.country}::text IS NULL OR ${vetCountry} = ${f.country})
        AND (${f.from}::date IS NULL OR o.created_at::date >= ${f.from}::date) AND (${f.to}::date IS NULL OR o.created_at::date <= ${f.to}::date)
      ORDER BY o.created_at DESC LIMIT 10000`;
    rows = data.length;
    csv = toCsv(data, [
      ["sent", (r) => day(r.created_at)], ["veterinarian", (r) => r.vet], ["email", (r) => r.email], ["country", (r) => r.country], ["product", (r) => r.product],
      ["rule", (r) => r.rule], ["discount_percent", (r) => r.discount_percent],
      ["status", (r) => (r.status === "open" && r.expires_at.getTime() < Date.now() ? "expired" : r.status)],
      ["using_product", (r) => (r.using_product == null ? null : r.using_product ? "yes" : "no")], ["rating", (r) => r.rating], ["feedback", (r) => r.comment],
      ["discount_code", (r) => r.discount_code], ["answered", (r) => day(r.completed_at)],
    ]);
  } else if (type === "downloads") {
    const data = await sql<{ at: Date; material: string; category: string | null; product: string | null; vet: string | null; email: string | null; country: string | null }[]>`
      SELECT d.at, m.title AS material, m.category, p.product_family AS product, u.name AS vet, u.email, ${vetCountry} AS country
      FROM marketing_downloads d JOIN marketing_materials m ON m.id = d.material_id LEFT JOIN products p ON p.id = m.product_id
      LEFT JOIN users u ON u.id = d.user_id LEFT JOIN clinics c ON c.id = u.clinic_id
      WHERE (${f.productId}::uuid IS NULL OR m.product_id = ${f.productId}) AND (${f.country}::text IS NULL OR ${vetCountry} = ${f.country})
        AND (${f.from}::date IS NULL OR d.at::date >= ${f.from}::date) AND (${f.to}::date IS NULL OR d.at::date <= ${f.to}::date)
      ORDER BY d.at DESC LIMIT 10000`;
    rows = data.length;
    csv = toCsv(data, [
      ["downloaded", (r) => r.at.toISOString()], ["material", (r) => r.material], ["category", (r) => r.category], ["product", (r) => r.product],
      ["user", (r) => r.vet], ["email", (r) => r.email], ["country", (r) => r.country],
    ]);
  } else {
    const data = await sql<{ created_at: Date; sent_at: Date | null; kind: string; rule: string | null; vet: string | null; to_email: string; country: string | null; product: string | null; subject: string; status: string; attempts: number }[]>`
      SELECT o.created_at, o.sent_at, o.kind, r.name AS rule, u.name AS vet, o.to_email, ${vetCountry} AS country, p.product_family AS product, o.subject, o.status, o.attempts
      FROM outbound_emails o LEFT JOIN users u ON u.id = o.user_id LEFT JOIN clinics c ON c.id = u.clinic_id
      LEFT JOIN reminder_rules r ON r.id = o.rule_id LEFT JOIN vet_events e ON e.id = o.event_id LEFT JOIN products p ON p.id = coalesce(e.product_id, r.product_id)
      WHERE (${f.productId}::uuid IS NULL OR coalesce(e.product_id, r.product_id) = ${f.productId}) AND (${f.country}::text IS NULL OR ${vetCountry} = ${f.country})
        AND (${f.from}::date IS NULL OR o.created_at::date >= ${f.from}::date) AND (${f.to}::date IS NULL OR o.created_at::date <= ${f.to}::date)
      ORDER BY o.created_at DESC LIMIT 10000`;
    rows = data.length;
    csv = toCsv(data, [
      ["created", (r) => r.created_at.toISOString()], ["sent", (r) => r.sent_at?.toISOString() ?? null], ["kind", (r) => (r.kind === "rule" ? "reminder rule" : "written")],
      ["rule", (r) => r.rule], ["recipient", (r) => r.vet], ["email", (r) => r.to_email], ["country", (r) => r.country], ["product", (r) => r.product],
      ["subject", (r) => r.subject], ["status", (r) => r.status], ["attempts", (r) => r.attempts],
    ]);
  }
  await audit(actor, { action: `report.${type}`, entityType: "report", tool: "ui", inputSummary: `${rows} rows; filters: ${Object.entries(f).filter(([, v]) => v).map(([k]) => k).join(", ") || "none"}` });
  return { csv, rows };
}
