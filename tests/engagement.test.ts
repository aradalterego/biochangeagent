import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { sql, closeDb } from "@/lib/db";
import { AuthorizationError, NotFoundError, ValidationError, type Actor } from "@/lib/authz";
import { createCase } from "@/server/domain/cases";
import {
  composeEmail, getOfferForUser, logEventFromAdmin, recordUsageQuestion, recordVetEvent, renderTemplate, runEngagementJobs, saveRule, saveTemplate,
  submitOfferFeedback, type RuleInput,
} from "@/server/domain/engagement";
import { listDashboardVets, listDashboardCases } from "@/server/domain/dashboard";
import { buildReport } from "@/server/domain/reports";
import { actorFor } from "./helpers";

const sent: { to: string; subject: string; text: string }[] = [];
vi.mock("@/lib/email", () => ({
  sendEmail: async (m: { to: string; subject: string; text: string }) => {
    sent.push(m);
  },
}));

let admin: Actor;
let medical: Actor;
let vetA: Actor; // customer, Spain
let vetB: Actor; // not a customer, Portugal
let productId: string;
let otherProductId: string;
const DAY = 864e5;

const rule = (over: Partial<RuleInput>): RuleInput => ({
  name: "Rule", reminderType: "check_in", triggerEvent: "purchase", productId: null, delayDays: 30, repeatEveryDays: null, maxSends: 1,
  audience: "all", templateId: null, subject: "Hi {{first_name}}", body: "How is {{product}}?", offerDiscount: false, discountPercent: null,
  offerValidDays: 30, appliesFrom: "2020-01-01", active: true, ...over,
});

async function mkVet(email: string, name: string, country: string, customer: boolean): Promise<Actor> {
  const [clinic] = await sql<{ id: string }[]>`INSERT INTO clinics (name, country) VALUES (${`${name} practice`}, ${country}) RETURNING id`;
  const [u] = await sql<{ id: string }[]>`
    INSERT INTO users (email, name, role, clinic_id, country, professional_title, is_customer)
    VALUES (${email}, ${name}, 'veterinarian', ${clinic.id}, ${country}, 'DVM', ${customer}) RETURNING id`;
  return { userId: u.id, role: "veterinarian", clinicId: clinic.id };
}

beforeAll(async () => {
  admin = await actorFor("admin@demo.biochange.test");
  medical = await actorFor("medical@demo.biochange.test");
  vetA = await mkVet("engage-a@mvp.test", "Ana Ruiz", "Spain", true);
  vetB = await mkVet("engage-b@mvp.test", "Bruno Costa", "Portugal", false);
  [{ id: productId }] = await sql<{ id: string }[]>`SELECT id FROM products WHERE product_family = 'ReGum Vet' ORDER BY created_at LIMIT 1`;
  [{ id: otherProductId }] = await sql<{ id: string }[]>`SELECT id FROM products WHERE product_family = 'MicroFoam' ORDER BY created_at LIMIT 1`;
});

afterAll(() => closeDb());

describe("trigger events", () => {
  it("records a purchase once per source and marks the veterinarian as a customer", async () => {
    const ref = `test-order:${vetB.userId}`;
    const first = await recordVetEvent(sql, { userId: vetB.userId, type: "purchase", productId, source: "order", sourceRef: ref });
    const again = await recordVetEvent(sql, { userId: vetB.userId, type: "purchase", productId, source: "order", sourceRef: ref });
    expect(first).toBeTruthy();
    expect(again).toBeNull();
    const [u] = await sql<{ is_customer: boolean }[]>`SELECT is_customer FROM users WHERE id = ${vetB.userId}`;
    expect(u.is_customer).toBe(true);
    await sql`DELETE FROM vet_events WHERE source_ref = ${ref}`;
    await sql`UPDATE users SET is_customer = false WHERE id = ${vetB.userId}`;
  });

  it("records product use when a case is treated, and a usage question once per conversation", async () => {
    const c = await createCase(vetA, { tooth: "301", product: "ReGum Vet", treatmentDate: "2026-03-01" });
    const [e] = await sql<{ event_type: string; product_id: string }[]>`SELECT event_type, product_id FROM vet_events WHERE source_ref = ${`case:${c.id}`}`;
    expect(e).toMatchObject({ event_type: "product_used", product_id: productId });

    const [conv] = await sql<{ id: string }[]>`INSERT INTO conversations (user_id, clinic_id) VALUES (${vetA.userId}, ${vetA.clinicId}) RETURNING id`;
    await recordUsageQuestion(vetA.userId, conv.id, "How do I apply MicroFoam after extraction?");
    await recordUsageQuestion(vetA.userId, conv.id, "And how long should it stay?");
    const q = await sql<{ product_id: string }[]>`SELECT product_id FROM vet_events WHERE source_ref = ${`conversation:${conv.id}`}`;
    expect(q).toHaveLength(1);
    expect(q[0].product_id).toBe(otherProductId);
  });

  it("lets only a BioChange admin log an event by hand", async () => {
    await expect(logEventFromAdmin(vetA, { userId: vetB.userId, type: "purchase", productId, occurredAt: null, notes: null })).rejects.toBeInstanceOf(AuthorizationError);
    await expect(logEventFromAdmin(admin, { userId: admin.userId, type: "purchase", productId, occurredAt: null, notes: null })).rejects.toBeInstanceOf(ValidationError);
    await expect(logEventFromAdmin(admin, { userId: vetB.userId, type: "bogus", productId, occurredAt: null, notes: null })).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("reminder rules", () => {
  it("validates the rule", async () => {
    await expect(saveRule(medical, rule({}))).rejects.toBeInstanceOf(AuthorizationError);
    await expect(saveRule(admin, rule({ delayDays: -1 }))).rejects.toBeInstanceOf(ValidationError);
    await expect(saveRule(admin, rule({ maxSends: 3, repeatEveryDays: null }))).rejects.toThrow(/Repeat every/);
    await expect(saveRule(admin, rule({ reminderType: "feedback_offer", discountPercent: null }))).rejects.toThrow(/discount/);
    await expect(saveRule(admin, rule({ subject: null, body: null }))).rejects.toThrow(/subject/);
  });

  it("sends after the interval, repeats, respects audience and product, and never sends twice", async () => {
    const r = await saveRule(admin, rule({ name: "Check-in after purchase", productId, delayDays: 30, maxSends: 2, repeatEveryDays: 30, audience: "customers" }));
    const purchase = await logEventFromAdmin(admin, { userId: vetA.userId, type: "purchase", productId, occurredAt: "2026-01-01", notes: "distributor order" });
    expect(purchase).toBeUndefined();
    // Not a customer → excluded by audience. Other product → excluded by product.
    await recordVetEvent(sql, { userId: vetB.userId, type: "purchase", productId, occurredAt: "2026-01-01", source: "admin" });
    await sql`UPDATE users SET is_customer = false WHERE id = ${vetB.userId}`;
    await recordVetEvent(sql, { userId: vetA.userId, type: "purchase", productId: otherProductId, occurredAt: "2026-01-01", source: "admin" });

    const mailsForRule = () => sql<{ to_email: string; subject: string; body: string; status: string }[]>`SELECT to_email, subject, body, status FROM outbound_emails WHERE rule_id = ${r} ORDER BY created_at`;

    await runEngagementJobs({ now: new Date("2026-01-20") });
    expect(await mailsForRule()).toHaveLength(0);

    await runEngagementJobs({ now: new Date("2026-02-01") });
    let mails = await mailsForRule();
    expect(mails).toHaveLength(1);
    expect(mails[0]).toMatchObject({ to_email: "engage-a@mvp.test", subject: "Hi Ana", body: "How is ReGum Vet?", status: "sent" });
    expect(sent.some((m) => m.to === "engage-a@mvp.test" && m.subject === "Hi Ana")).toBe(true);

    await runEngagementJobs({ now: new Date("2026-02-02") });
    expect(await mailsForRule()).toHaveLength(1);

    await runEngagementJobs({ now: new Date("2026-03-04") });
    mails = await mailsForRule();
    expect(mails).toHaveLength(2);
    await runEngagementJobs({ now: new Date("2026-06-01") });
    expect(await mailsForRule()).toHaveLength(2); // max 2 emails
    await sql`UPDATE reminder_rules SET active = false WHERE id = ${r}`;
  });

  it("ignores events before the rule's start date", async () => {
    const r = await saveRule(admin, rule({ name: "Registered welcome", triggerEvent: "registered", delayDays: 0, appliesFrom: "2099-01-01" }));
    await runEngagementJobs();
    const [n] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM outbound_emails WHERE rule_id = ${r}`;
    expect(n.n).toBe(0);
    await sql`UPDATE reminder_rules SET active = false WHERE id = ${r}`;
  });

  it("sends a check-in after a usage question to the agent", async () => {
    const r = await saveRule(admin, rule({ name: "Usage check-in", triggerEvent: "usage_question", reminderType: "usage_support", delayDays: 7, subject: "Is everything OK with {{product}}?" }));
    await runEngagementJobs({ now: new Date(Date.now() + 8 * DAY) });
    const mails = await sql<{ to_email: string; subject: string }[]>`SELECT to_email, subject FROM outbound_emails WHERE rule_id = ${r}`;
    expect(mails).toEqual([{ to_email: "engage-a@mvp.test", subject: "Is everything OK with MicroFoam?" }]);
    await sql`UPDATE reminder_rules SET active = false WHERE id = ${r}`;
  });
});

describe("feedback for a discount", () => {
  it("issues a discount code only to a veterinarian who uses the product now, once, and only to them", async () => {
    const r = await saveRule(admin, rule({ name: "Feedback offer", reminderType: "feedback_offer", triggerEvent: "product_used", delayDays: 14, discountPercent: 15, body: "Tell us about {{product}}" }));
    await runEngagementJobs();
    const [mail] = await sql<{ body: string }[]>`SELECT body FROM outbound_emails WHERE rule_id = ${r} AND to_email = 'engage-a@mvp.test'`;
    const offerId = mail.body.match(/\/offers\/([0-9a-f-]{36})/)?.[1];
    expect(offerId).toBeTruthy();
    expect(mail.body).toContain("15% off");

    await expect(getOfferForUser(vetB, offerId!)).rejects.toBeInstanceOf(NotFoundError);
    await expect(submitOfferFeedback(vetA, offerId!, { usingProduct: "yes", rating: 9, comment: "Great" })).rejects.toBeInstanceOf(ValidationError);
    const done = await submitOfferFeedback(vetA, offerId!, { usingProduct: "yes", rating: 5, comment: "Handles well, fast healing." });
    expect(done.status).toBe("completed");
    expect(done.discount_code).toMatch(/^BC-[A-Z0-9]{8}$/);
    expect(sent.some((m) => m.to === "engage-a@mvp.test" && m.text.includes(done.discount_code!))).toBe(true);
    await expect(submitOfferFeedback(vetA, offerId!, { usingProduct: "yes", rating: 5, comment: "again" })).rejects.toThrow(/already/);
    await sql`UPDATE reminder_rules SET active = false WHERE id = ${r}`;
  });

  it("records feedback without a code when the product is not in use", async () => {
    const [o] = await sql<{ id: string }[]>`INSERT INTO feedback_offers (user_id, discount_percent, expires_at) VALUES (${vetB.userId}, 10, now() + interval '5 days') RETURNING id`;
    const done = await submitOfferFeedback(vetB, o.id, { usingProduct: "no", rating: 3, comment: "Not yet started." });
    expect(done).toMatchObject({ status: "not_eligible", discount_code: null });
  });
});

describe("emails written in Admin", () => {
  it("renders merge tags and sends to chosen veterinarians or a segment", async () => {
    expect(renderTemplate("Hi {{ first_name }} {{unknown}}", { first_name: "Ana" })).toBe("Hi Ana {{unknown}}");
    await expect(composeEmail(medical, { audience: "all", userIds: [], country: null, productId: null, subject: "x", body: "y", templateId: null })).rejects.toBeInstanceOf(AuthorizationError);
    await expect(composeEmail(admin, { audience: "selected", userIds: [], country: null, productId: null, subject: "x", body: "y", templateId: null })).rejects.toBeInstanceOf(ValidationError);

    const before = sent.length;
    const res = await composeEmail(admin, { audience: "selected", userIds: [vetA.userId, vetB.userId], country: null, productId: null, subject: "News for {{first_name}}", body: "Dear {{title}} {{name}}", templateId: null });
    expect(res).toMatchObject({ queued: 2, sent: 2, failed: 0 });
    expect(sent.slice(before).map((m) => m.subject).sort()).toEqual(["News for Ana", "News for Bruno"]);
    expect(sent.slice(before).find((m) => m.to === "engage-b@mvp.test")?.text).toBe("Dear DVM Bruno Costa");

    const portugal = await composeEmail(admin, { audience: "all", userIds: [], country: "Portugal", productId: null, subject: "PT", body: "Olá", templateId: null });
    expect(portugal.queued).toBe(1);
  });

  it("saves templates", async () => {
    await expect(saveTemplate(admin, { name: "T", subject: null, body: "b" })).rejects.toBeInstanceOf(ValidationError);
    const id = await saveTemplate(admin, { name: "Welcome", subject: "Welcome {{first_name}}", body: "Hello" });
    const [t] = await sql<{ name: string }[]>`SELECT name FROM email_templates WHERE id = ${id}`;
    expect(t.name).toBe("Welcome");
  });
});

describe("reports", () => {
  it("filters veterinarians by country, customer, product and period", async () => {
    await expect(listDashboardVets(vetA)).rejects.toBeInstanceOf(AuthorizationError);
    const spain = await listDashboardVets(medical, { country: "Spain" });
    expect(spain.map((v) => v.email)).toContain("engage-a@mvp.test");
    expect(spain.map((v) => v.email)).not.toContain("engage-b@mvp.test");
    expect((await listDashboardVets(medical, { customer: "no" })).map((v) => v.email)).toContain("engage-b@mvp.test");
    const regum = await listDashboardVets(medical, { productId, from: "2026-02-01", to: "2026-03-31" });
    const a = regum.find((v) => v.email === "engage-a@mvp.test");
    expect(a?.cases).toBe(1);
    expect((await listDashboardVets(medical, { from: "2030-01-01" })).map((v) => v.email)).not.toContain("engage-a@mvp.test");
  });

  it("filters cases by country and created date and downloads every report type", async () => {
    const { rows } = await listDashboardCases(medical, { country: "Spain" });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.country === "Spain")).toBe(true);
    const created = await listDashboardCases(medical, { country: "Spain", dateField: "created", treatedFrom: "2030-01-01" });
    expect(created.total).toBe(0);

    for (const type of ["cases", "vets", "offers", "downloads", "emails"] as const) {
      const r = await buildReport(medical, type, { country: "Spain" });
      expect(r.csv.split("\r\n")[0]).toMatch(/,/);
    }
    const vets = await buildReport(medical, "vets", { country: "Spain", customer: "yes" });
    expect(vets.csv).toContain("engage-a@mvp.test");
    expect(vets.csv).not.toContain("engage-b@mvp.test");
    const offers = await buildReport(medical, "offers", { product: productId });
    expect(offers.csv).toMatch(/BC-[A-Z0-9]{8}/);
    await expect(buildReport(vetA, "cases", {})).rejects.toBeInstanceOf(AuthorizationError);
  });
});
