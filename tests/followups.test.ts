import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { sql, closeDb } from "@/lib/db";
import { AuthorizationError, ValidationError, type Actor } from "@/lib/authz";
import { resetEnvCache } from "@/lib/env";
import { closeCase, completeFollowUp, createCase, updateCase } from "@/server/domain/cases";
import { getFollowUpSettings, runFollowUpReminders, saveFollowUpSettings } from "@/server/domain/followUpReminders";
import { GET as cronGET } from "@/app/api/cron/follow-ups/route";
import { actorFor } from "./helpers";

const sent: { to: string; subject: string; text: string }[] = [];
const failFor = new Set<string>();
vi.mock("@/lib/email", () => ({
  sendEmail: async (m: { to: string; subject: string; text: string }) => {
    if (failFor.has(m.to)) throw new Error("provider down");
    sent.push(m);
  },
}));

let vet: Actor;
let admin: Actor;
let vetEmail: string;

const day = (offset: number) => new Date(Date.now() + offset * 864e5).toISOString().slice(0, 10);
const followUps = (caseId: string) =>
  sql<{ id: string; kind: string; status: string; due_at: Date; reminder_status: string }[]>`
    SELECT id, kind, status, due_at, reminder_status FROM follow_ups WHERE case_id = ${caseId} ORDER BY created_at`;
const mailsFor = (caseId: string) => sent.filter((m) => m.text.includes(`/cases/${caseId}`));

beforeAll(async () => {
  // A dedicated clinic + vet so other test files' cases don't affect counts.
  const [clinic] = await sql<{ id: string }[]>`INSERT INTO clinics (name, timezone) VALUES ('Follow-up Test Clinic', 'Europe/Berlin') RETURNING id`;
  vetEmail = "followup-vet@mvp.test";
  const [u] = await sql<{ id: string }[]>`INSERT INTO users (email, name, role, clinic_id) VALUES (${vetEmail}, 'Dr. Follow', 'veterinarian', ${clinic.id}) RETURNING id`;
  vet = { userId: u.id, role: "veterinarian", clinicId: clinic.id };
  admin = await actorFor("admin@demo.biochange.test");
});

afterAll(() => closeDb());

describe("default follow-up", () => {
  it("is scheduled 90 days after the treatment date", async () => {
    expect((await getFollowUpSettings()).defaultDays).toBe(90);
    const c = await createCase(vet, { tooth: "501", treatmentDate: "2026-01-10" });
    const f = await followUps(c.id);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ kind: "default", status: "scheduled", reminder_status: "pending" });
    expect(f[0].due_at.toISOString().slice(0, 10)).toBe("2026-04-10");
    expect(c.next_follow_up?.toISOString().slice(0, 10)).toBe("2026-04-10");
  });

  it("is created when a treatment date is added and moves with it, never duplicated", async () => {
    const c = await createCase(vet, { tooth: "502" });
    expect(await followUps(c.id)).toHaveLength(0);
    await updateCase(vet, c.id, { treatmentDate: "2026-02-01" });
    await updateCase(vet, c.id, { treatmentDate: "2026-02-01" });
    expect((await followUps(c.id)).map((f) => f.due_at.toISOString().slice(0, 10))).toEqual(["2026-05-02"]);
    await updateCase(vet, c.id, { treatmentDate: "2026-03-01" });
    const f = await followUps(c.id);
    expect(f).toHaveLength(1);
    expect(f[0].due_at.toISOString().slice(0, 10)).toBe("2026-05-30");
  });

  it("is not added when the veterinarian planned a follow-up", async () => {
    const c = await createCase(vet, { tooth: "503", treatmentDate: "2026-01-01", followUpDate: "2026-02-15" });
    const f = await followUps(c.id);
    expect(f).toHaveLength(1);
    expect(f[0].kind).toBe("manual");
  });

  it("uses the period set by a BioChange admin", async () => {
    await expect(saveFollowUpSettings(vet, { defaultDays: 30, overdueReminderDays: 14, remindersEnabled: true })).rejects.toBeInstanceOf(AuthorizationError);
    await expect(saveFollowUpSettings(admin, { defaultDays: 0, overdueReminderDays: 14, remindersEnabled: true })).rejects.toBeInstanceOf(ValidationError);
    await saveFollowUpSettings(admin, { defaultDays: 30, overdueReminderDays: 14, remindersEnabled: true });
    const c = await createCase(vet, { tooth: "504", treatmentDate: "2026-01-01" });
    expect((await followUps(c.id))[0].due_at.toISOString().slice(0, 10)).toBe("2026-01-31");
    await saveFollowUpSettings(admin, { defaultDays: 90, overdueReminderDays: 14, remindersEnabled: true });
    const [a] = await sql<{ input_summary: string }[]>`SELECT input_summary FROM audit_log WHERE action = 'settings.follow_up' ORDER BY id DESC LIMIT 1`;
    expect(a.input_summary).toContain("30→90");
  });
});

describe("reminder emails", () => {
  it("emails the treating vet once when due, then once more when overdue", async () => {
    const c = await createCase(vet, { tooth: "601", product: "ReGum Vet", treatmentDate: day(-120), conditionSummary: "secret-condition-text" });
    // due 30 days ago → the due reminder now, the overdue reminder (14 days) on the next run
    await runFollowUpReminders();
    let mails = mailsFor(c.id);
    expect(mails).toHaveLength(1);
    expect(mails[0].to).toBe(vetEmail);
    expect(mails[0].subject).toMatch(/^Follow-up due: ReGum Vet · tooth 601/);
    expect(mails[0].text).not.toContain("secret-condition-text");
    expect((await followUps(c.id))[0].reminder_status).toBe("sent");

    await runFollowUpReminders();
    mails = mailsFor(c.id);
    expect(mails).toHaveLength(2);
    expect(mails[1].subject).toMatch(/^Follow-up overdue/);

    await runFollowUpReminders();
    await runFollowUpReminders();
    expect(mailsFor(c.id)).toHaveLength(2); // never duplicated
  });

  it("does not remind about future, completed or closed follow-ups", async () => {
    const future = await createCase(vet, { tooth: "602", treatmentDate: day(-10) });
    const done = await createCase(vet, { tooth: "603", treatmentDate: day(-100) });
    await completeFollowUp(vet, (await followUps(done.id))[0].id, { pocketDepthMm: 3 });
    const closed = await createCase(vet, { tooth: "604", treatmentDate: day(-100) });
    await closeCase(vet, closed.id, null);
    await runFollowUpReminders();
    expect(mailsFor(future.id)).toHaveLength(0);
    expect(mailsFor(done.id)).toHaveLength(0);
    expect(mailsFor(closed.id)).toHaveLength(0);
    expect((await followUps(done.id))[0].reminder_status).toBe("not_required");
  });

  it("retries a failed send later and records the failure", async () => {
    const [u] = await sql<{ id: string }[]>`INSERT INTO users (email, name, role, clinic_id) VALUES ('flaky@mvp.test', 'Dr. Flaky', 'veterinarian', ${vet.clinicId}) RETURNING id`;
    const flaky: Actor = { userId: u.id, role: "veterinarian", clinicId: vet.clinicId };
    const c = await createCase(flaky, { tooth: "605", treatmentDate: day(-95) });
    failFor.add("flaky@mvp.test");
    const r = await runFollowUpReminders();
    expect(r.failed).toBeGreaterThanOrEqual(1);
    const [job] = await sql<{ id: string; status: string; attempts: number; last_error: string }[]>`
      SELECT id, status, attempts, last_error FROM notification_outbox WHERE case_id = ${c.id}`;
    expect(job).toMatchObject({ status: "failed", attempts: 1 });
    expect(job.last_error).toContain("provider down");
    expect((await followUps(c.id))[0].reminder_status).toBe("failed");

    failFor.delete("flaky@mvp.test");
    await runFollowUpReminders(); // backoff: not retried within the hour
    expect(mailsFor(c.id)).toHaveLength(0);
    await sql`UPDATE notification_outbox SET locked_at = now() - interval '2 hours' WHERE id = ${job.id}`;
    await runFollowUpReminders();
    expect(mailsFor(c.id)).toHaveLength(1);
    expect((await followUps(c.id))[0].reminder_status).toBe("sent");
  });

  it("skips inactive recipients and sends nothing when reminders are off", async () => {
    const [u] = await sql<{ id: string }[]>`INSERT INTO users (email, name, role, clinic_id) VALUES ('gone@mvp.test', 'Dr. Gone', 'veterinarian', ${vet.clinicId}) RETURNING id`;
    const c = await createCase({ userId: u.id, role: "veterinarian", clinicId: vet.clinicId }, { tooth: "606", treatmentDate: day(-95) });
    await sql`UPDATE users SET active = false WHERE id = ${u.id}`;
    await runFollowUpReminders();
    expect(mailsFor(c.id)).toHaveLength(0);
    expect((await followUps(c.id))[0].reminder_status).toBe("skipped");

    await saveFollowUpSettings(admin, { defaultDays: 90, overdueReminderDays: 14, remindersEnabled: false });
    const off = await createCase(vet, { tooth: "607", treatmentDate: day(-95) });
    expect(await runFollowUpReminders()).toEqual({ enqueued: 0, sent: 0, failed: 0, skipped: 0 });
    expect(mailsFor(off.id)).toHaveLength(0);
    await saveFollowUpSettings(admin, { defaultDays: 90, overdueReminderDays: 14, remindersEnabled: true });
  });
});

describe("cron endpoint", () => {
  it("requires the shared secret", async () => {
    const secret = "s".repeat(40);
    process.env.CRON_SECRET = secret;
    resetEnvCache();
    try {
      expect((await cronGET(new Request("http://localhost/api/cron/follow-ups"))).status).toBe(401);
      expect((await cronGET(new Request("http://localhost/api/cron/follow-ups", { headers: { authorization: "Bearer wrong" } }))).status).toBe(401);
      const ok = await cronGET(new Request("http://localhost/api/cron/follow-ups", { headers: { authorization: `Bearer ${secret}` } }));
      expect(ok.status).toBe(200);
      expect(await ok.json()).toMatchObject({ ok: true });
    } finally {
      delete process.env.CRON_SECRET;
      resetEnvCache();
    }
  });
});
