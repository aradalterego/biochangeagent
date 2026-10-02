/**
 * Spec §38 acceptance loop, end to end through processMessage() with a scripted model:
 * login → known user → case question → approved sourced answer → save case → record usage →
 * inventory changes → follow-up → return later (case remembered, follow-up surfaced) →
 * record result → low stock detected → reorder prepared → explicit confirmation → audited.
 */
import { afterAll, describe, expect, it } from "vitest";
import { sql, closeDb } from "@/lib/db";
import { attemptLogin } from "@/lib/auth/login";
import { processMessage } from "@/server/agent/processMessage";
import { getTodayCards } from "@/server/domain/today";
import { getInventory, estimateInventory } from "@/server/domain/inventory";
import { confirmOrder, getOrder, updateOrderStatus } from "@/server/domain/orders";
import { getCase } from "@/server/domain/cases";
import { actorFor, noExtraction, runtimeContext, scriptedClient, toolOutput } from "./helpers";

afterAll(() => closeDb());

const VET = "vet@demo.biochange.test";

describe("V1 acceptance loop", () => {
  let conversationId = "";
  let caseId = "";
  let orderId = "";

  it("logs the veterinarian in and knows who they are", async () => {
    const res = await attemptLogin(VET, "DemoVet2026!", "127.0.0.1");
    expect(res.ok).toBe(true);
    const bad = await attemptLogin(VET, "wrong-password-1", "127.0.0.1");
    expect(bad.ok).toBe(false);
  });

  it("answers a real case question from approved knowledge, with a visible source", async () => {
    const actor = await actorFor(VET);
    let ctxSeen: any; // eslint-disable-line @typescript-eslint/no-explicit-any
    const client = scriptedClient([
      (input) => {
        ctxSeen = runtimeContext(input);
        return { calls: [{ name: "search_knowledge", args: { query: "ReGum Vet application steps surgical site", product: "ReGum Vet", source_types: null, authority_threshold: null } }] };
      },
      (input) => {
        const out = toolOutput(input, "search_knowledge");
        const step = out.passages.find((p: { text: string }) => /Trim ReGum/i.test(p.text));
        expect(step).toBeTruthy();
        return { text: `For an open flap on 204: wet ReGum Vet, trim it to the defect, place it after debridement and close the site [${step.label}]. Would you like me to save this as a case?` };
      },
    ]);
    const msg = await processMessage({ actor, channel: "web", content: "I have a 7mm pocket on 204 and I'm doing an open flap." }, { client, runExtraction: noExtraction });
    conversationId = msg.conversationId;

    // The system knows the user, clinic, memories and adoption state.
    expect(ctxSeen.user.name).toBe("Dr. Dana Levi");
    expect(ctxSeen.clinic.name).toBe("Demo Veterinary Dental Clinic");
    expect(ctxSeen.memories.some((m: { fact: string }) => /concise/.test(m.fact))).toBe(true);
    expect(ctxSeen.adoption.state).toBeTruthy();

    expect(msg.error).toBe(false);
    expect(msg.sources.length).toBe(1);
    expect(msg.sources[0].title).toMatch(/ReGum Vet/);
    expect(msg.sources[0].authorityLevel).toBe(1);
  });

  it("does not save a case without the vet's agreement", async () => {
    const actor = await actorFor(VET);
    let refusal: any; // eslint-disable-line @typescript-eslint/no-explicit-any
    const client = scriptedClient([
      () => ({ calls: [{ name: "create_case", args: caseArgs(false) }] }),
      (input) => {
        refusal = toolOutput(input, "create_case");
        return { text: "Shall I save it?" };
      },
    ]);
    await processMessage({ actor, channel: "web", content: "What do you think?", conversationId }, { client, runExtraction: noExtraction });
    expect(refusal.ok).toBe(false);
    const [{ n }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM cases WHERE tooth = '204'`;
    expect(n).toBe(0);
  });

  it("saves the case when asked", async () => {
    const actor = await actorFor(VET);
    const client = scriptedClient([
      () => ({ calls: [{ name: "create_case", args: caseArgs(true) }] }),
      (input) => {
        const out = toolOutput(input, "create_case");
        expect(out.ok).toBe(true);
        caseId = out.case.id;
        return { text: "Saved the case for tooth 204." };
      },
    ]);
    const msg = await processMessage({ actor, channel: "web", content: "Yes, save it as a case.", conversationId }, { client, runExtraction: noExtraction });
    expect(msg.activeCaseId).toBe(caseId);
    expect(msg.pendingActions[0]).toMatchObject({ type: "open_case", caseId });
    const c = await getCase(actor, caseId);
    expect(c.measurements[0]).toMatchObject({ kind: "baseline" });
    expect(Number(c.measurements[0].pocket_depth_mm)).toBe(7);
  });

  it("records the product used and lowers ESTIMATED inventory", async () => {
    const actor = await actorFor(VET);
    const before = (await getInventory(actor, "ReGum Vet"))[0];
    const client = scriptedClient([
      (input) => {
        const ctx = runtimeContext(input);
        expect(ctx.active_case.id).toBe(caseId); // "that case" resolves from conversation state
        return { calls: [{ name: "record_product_usage", args: { product: "ReGum Vet", quantity: 1, case_id: ctx.active_case.id } }] };
      },
      (input) => {
        const out = toolOutput(input, "record_product_usage");
        return { text: `Recorded. Estimated stock: ${out.estimatedStock}.` };
      },
    ]);
    await processMessage({ actor, channel: "web", content: "I used one ReGum in that case.", conversationId }, { client, runExtraction: noExtraction });
    const after = (await getInventory(actor, "ReGum Vet"))[0];
    expect(after.quantityEstimated).toBe(before.quantityEstimated! - 1);
    expect(after.quantityConfirmed).toBe(before.quantityConfirmed); // confirmed count untouched
    const c = await getCase(actor, caseId);
    expect(c.case.status).toBe("treated");
  });

  it("creates a follow-up", async () => {
    const actor = await actorFor(VET);
    const due = new Date(Date.now() + 2 * 864e5).toISOString().slice(0, 10);
    const client = scriptedClient([
      () => ({ calls: [{ name: "schedule_case_followup", args: { case_id: null, due_date: due, reason: "Recheck" } }] }),
      () => ({ text: "Follow-up scheduled." }),
    ]);
    await processMessage({ actor, channel: "web", content: `Schedule a recheck on ${due}.`, conversationId }, { client, runExtraction: noExtraction });
    const c = await getCase(actor, caseId);
    expect(c.followUps.filter((f) => f.status === "scheduled")).toHaveLength(1);
  });

  it("later: remembers the case and surfaces the follow-up", async () => {
    const actor = await actorFor(VET);
    const cards = await getTodayCards(actor);
    expect(cards.some((c) => c.kind.startsWith("follow_up") && c.href === `/cases/${caseId}`)).toBe(true);

    let found: any; // eslint-disable-line @typescript-eslint/no-explicit-any
    const client = scriptedClient([
      (input) => {
        const ctx = runtimeContext(input);
        expect(ctx.follow_ups.due_week).toBeGreaterThanOrEqual(1);
        return { calls: [{ name: "search_cases", args: { query: null, status: null, tooth: "204" } }] };
      },
      (input) => {
        found = toolOutput(input, "search_cases");
        return { calls: [{ name: "complete_case_followup", args: { case_id: found.cases[0].id, follow_up_id: null, pocket_depth_mm: 4, attachment_level_mm: null, mobility: null, furcation: null, notes: "Healed well", outcome: "PD reduced to 4 mm" } }] };
      },
      () => ({ text: "Recorded the follow-up: PD now 4 mm (baseline 7 mm)." }),
    ]);
    // A NEW conversation: nothing carried over except the database.
    const msg = await processMessage({ actor, channel: "web", content: "The dog with the 204 pocket is back. PD is 4mm now, healed well." }, { client, runExtraction: noExtraction });
    expect(msg.conversationId).not.toBe(conversationId);
    expect(found.cases[0].id).toBe(caseId);
    const c = await getCase(actor, caseId);
    expect(c.case.status).toBe("followed_up");
    expect(c.measurements.map((m) => [m.kind, Number(m.pocket_depth_mm)])).toEqual([["baseline", 7], ["follow_up", 4]]);
  });

  it("detects low inventory from recorded usage and prepares a reorder that needs explicit confirmation", async () => {
    const actor = await actorFor(VET);
    // Two more cases' worth of usage.
    const client1 = scriptedClient([
      () => ({ calls: [{ name: "record_product_usage", args: { product: "ReGum Vet", quantity: 1, case_id: null } }] }),
      () => ({ text: "Recorded." }),
    ]);
    await processMessage({ actor, channel: "web", content: "Used another ReGum today on a different dog." }, { client: client1, runExtraction: noExtraction });

    const [forecast] = await estimateInventory(actor, "ReGum Vet");
    expect(forecast.likelyLow).toBe(true);
    expect((await getTodayCards(actor)).some((c) => c.kind === "inventory_low")).toBe(true);

    const client2 = scriptedClient([
      () => ({ calls: [{ name: "estimate_inventory", args: { product: "ReGum Vet" } }, { name: "get_order_history", args: {} }] }),
      (input) => {
        const hist = toolOutput(input, "get_order_history");
        return { calls: [{ name: "prepare_order", args: { product: "ReGum Vet", quantity_packages: hist.orders[0].packages, notes: null } }] };
      },
      (input) => {
        const out = toolOutput(input, "prepare_order");
        orderId = out.order_id;
        return { text: "Based on your recorded use you're likely down to about 1 unit. I've prepared the same 2-package order as last time — please review and confirm below." };
      },
    ]);
    const msg = await processMessage({ actor, channel: "web", content: "How many do I have left? Order me the usual." }, { client: client2, runExtraction: noExtraction });
    expect(msg.pendingActions).toContainEqual(expect.objectContaining({ type: "confirm_order", orderId }));
    expect((await getOrder(actor, orderId)).status).toBe("draft");

    // The model cannot submit a draft; only the explicit confirmation step can.
    await expect(updateOrderStatus(actor, orderId, "submitted")).rejects.toThrow(/confirm/i);
    const confirmed = await confirmOrder(actor, orderId, { tool: "ui:chat_confirm" });
    expect(confirmed.status).toBe("submitted");
    expect(confirmed.quantity).toBe(2);
  });

  it("makes every action visible and auditable", async () => {
    const rows = await sql<{ action: string; tool: string | null; source_message_id: string | null }[]>`SELECT action, tool, source_message_id FROM audit_log ORDER BY id`;
    const actions = rows.map((r) => r.action);
    for (const a of ["case.create", "inventory.record_usage", "follow_up.schedule", "follow_up.complete", "order.prepare", "order.confirm_record"]) {
      expect(actions).toContain(a);
    }
    // Agent-initiated mutations link back to the chat message that triggered them.
    const agentRows = rows.filter((r) => r.tool === "create_case" || r.tool === "record_product_usage" || r.tool === "prepare_order");
    expect(agentRows.length).toBeGreaterThanOrEqual(3);
    expect(agentRows.every((r) => r.source_message_id)).toBe(true);
    const [{ n }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM messages WHERE conversation_id = ${conversationId}`;
    expect(n).toBeGreaterThanOrEqual(10);
  });
});

function caseArgs(confirmed: boolean) {
  return {
    internal_patient_identifier: null, species: "dog", breed: null, age: null, tooth: "204", condition_summary: "Periodontal pocket, open flap planned",
    pocket_depth_mm: 7, defect_type: null, furcation: null, procedure_type: "Open flap periodontal surgery", treatment_goal: null,
    product: "ReGum Vet", product_variant: null, treatment_date: null, status: "planned", baseline_notes: null, follow_up_date: null,
    outcome_notes: null, user_confirmed: confirmed,
  };
}
