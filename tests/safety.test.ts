import { afterAll, describe, expect, it } from "vitest";
import { sql, closeDb } from "@/lib/db";
import { AuthorizationError } from "@/lib/authz";
import { FALLBACK_ERROR, FALLBACK_NOT_CONFIGURED, processMessage } from "@/server/agent/processMessage";
import { searchKnowledge } from "@/server/knowledge/retrieve";
import { approveSource, createSource, revokeSource } from "@/server/knowledge/sources";
import { createCase, getCase } from "@/server/domain/cases";
import { prepareOrder } from "@/server/domain/orders";
import { buildInstructions } from "@/server/agent/systemPrompt";
import { actorFor, noExtraction, scriptedClient, toolOutput } from "./helpers";

afterAll(() => closeDb());

describe("knowledge governance", () => {
  it("never retrieves pending, placeholder or revoked sources", async () => {
    const admin = await actorFor("admin@demo.biochange.test");
    const id = await createSource(admin, { title: "Zebra protocol (test)", sourceType: "clinical_protocol", product: "ReGum Vet" }, {
      file: { name: "z.txt", data: Buffer.from("# Zebrafoam handling\nThe zebrafoam handling step is unique to this test document.") },
    });
    expect(await searchKnowledge({ query: "zebrafoam handling" })).toHaveLength(0); // pending review

    await approveSource(admin, id);
    const hits = await searchKnowledge({ query: "zebrafoam handling" });
    expect(hits[0]?.sourceId).toBe(id);
    expect(hits[0]?.authorityLevel).toBe(2);

    await revokeSource(admin, id, "test");
    expect(await searchKnowledge({ query: "zebrafoam handling" })).toHaveLength(0);
  });

  it("ranks higher authority first when relevance is similar", async () => {
    const admin = await actorFor("admin@demo.biochange.test");
    const low = await createSource(admin, { title: "Marketing note", sourceType: "commercial_information", product: "MicroFoam" }, { file: { name: "a.txt", data: Buffer.from("Quokkafoam placement depth is described here.") } });
    const high = await createSource(admin, { title: "IFU note", sourceType: "ifu", product: "MicroFoam" }, { file: { name: "b.txt", data: Buffer.from("Quokkafoam placement depth is described here.") } });
    await approveSource(admin, low);
    await approveSource(admin, high);
    const hits = await searchKnowledge({ query: "quokkafoam placement depth", product: "MicroFoam" });
    expect(hits.map((h) => h.sourceId).slice(0, 2)).toEqual([high, low]);
    expect((await searchKnowledge({ query: "quokkafoam placement depth", authorityThreshold: 3 })).map((h) => h.sourceId)).toEqual([high]);
  });

  it("logs a knowledge gap when nothing approved matches", async () => {
    const actor = await actorFor("vet@demo.biochange.test");
    const client = scriptedClient([
      () => ({ calls: [{ name: "search_knowledge", args: { query: "xylophone compatibility with antibiotics", product: null, source_types: null, authority_threshold: null } }] }),
      (input) => {
        expect(toolOutput(input, "search_knowledge").passages).toHaveLength(0);
        return { text: "I don't have enough approved BioChange information to answer that reliably. Would you like me to ask Medical Support?" };
      },
    ]);
    const msg = await processMessage({ actor, channel: "web", content: "Can xylophone be combined with systemic antibiotics?" }, { client, runExtraction: noExtraction });
    expect(msg.sources).toHaveLength(0);
    const [gap] = await sql<{ frequency: number }[]>`SELECT frequency FROM knowledge_gaps WHERE question ILIKE '%xylophone%'`;
    expect(gap.frequency).toBe(1);
  });

  it("does not show sources the answer did not cite, and ignores invented labels", async () => {
    const actor = await actorFor("vet@demo.biochange.test");
    const client = scriptedClient([() => ({ text: "General answer with a made-up citation [S9]." })]);
    const msg = await processMessage({ actor, channel: "web", content: "How do I trim ReGum Vet?" }, { client, runExtraction: noExtraction });
    expect(msg.sources).toHaveLength(0);
  });
});

describe("failure handling never fabricates", () => {
  it("returns a safe fallback when the model fails", async () => {
    const actor = await actorFor("vet@demo.biochange.test");
    const client = scriptedClient([() => { throw new Error("upstream 500"); }]);
    const msg = await processMessage({ actor, channel: "web", content: "What is the ReGum protocol?" }, { client, runExtraction: noExtraction });
    expect(msg.error).toBe(true);
    expect(msg.content).toBe(FALLBACK_ERROR);
    expect(msg.sources).toHaveLength(0);
  });

  it("explains when OpenAI is not configured", async () => {
    const actor = await actorFor("vet@demo.biochange.test");
    const msg = await processMessage({ actor, channel: "web", content: "Hello" }, { runExtraction: noExtraction });
    expect(msg.content).toBe(FALLBACK_NOT_CONFIGURED);
  });

  it("keeps product knowledge out of the system prompt", () => {
    const prompt = buildInstructions();
    expect(prompt).toContain("You are the BioChange Vet Companion.");
    expect(prompt).not.toMatch(/socket preservation|1 ?mm below the gumline|transglutaminase/i);
  });
});

describe("authorisation", () => {
  it("isolates clinics from each other, including through agent tools", async () => {
    const vet = await actorFor("vet@demo.biochange.test");
    const [other] = await sql<{ id: string }[]>`INSERT INTO clinics (name) VALUES ('Other clinic') RETURNING id`;
    const [u] = await sql<{ id: string }[]>`INSERT INTO users (email, name, role, clinic_id) VALUES ('other@x.test', 'Other Vet', 'veterinarian', ${other.id}) RETURNING id`;
    const outsider = { userId: u.id, role: "veterinarian" as const, clinicId: other.id };
    const c = await createCase(vet, { tooth: "108", conditionSummary: "test" });

    await expect(getCase(outsider, c.id)).rejects.toBeInstanceOf(AuthorizationError);

    const client = scriptedClient([
      () => ({ calls: [{ name: "get_case", args: { case_id: c.id } }, { name: "add_case_note", args: { case_id: c.id, note: "hijack" } }] }),
      (input) => {
        expect(toolOutput(input, "get_case")).toMatchObject({ ok: false, error: "not_authorized" });
        expect(toolOutput(input, "add_case_note")).toMatchObject({ ok: false, error: "not_authorized" });
        return { text: "I can't access that case." };
      },
    ]);
    await processMessage({ actor: outsider, channel: "web", content: `Show me case ${c.id}` }, { client, runExtraction: noExtraction });
    const [{ n }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM case_notes WHERE case_id = ${c.id}`;
    expect(n).toBe(0);
    const [denied] = await sql<{ result: string }[]>`SELECT result FROM audit_log WHERE action = 'tool.add_case_note' ORDER BY id DESC LIMIT 1`;
    expect(denied.result).toBe("denied");
  });

  it("does not let BioChange staff write clinic operational data", async () => {
    const admin = await actorFor("admin@demo.biochange.test");
    await expect(prepareOrder(admin, { productRef: "ReGum Vet", quantity: 1 })).rejects.toBeInstanceOf(AuthorizationError);
  });

  it("does not let a veterinarian manage knowledge", async () => {
    const vet = await actorFor("vet@demo.biochange.test");
    await expect(createSource(vet, { title: "x", sourceType: "ifu" })).rejects.toBeInstanceOf(AuthorizationError);
  });

  it("only lets a user continue their own conversations", async () => {
    const vet = await actorFor("vet@demo.biochange.test");
    const medical = await actorFor("medical@demo.biochange.test");
    const [conv] = await sql<{ id: string }[]>`SELECT id FROM conversations WHERE user_id = ${vet.userId} LIMIT 1`;
    await expect(processMessage({ actor: medical, channel: "web", content: "hi", conversationId: conv.id }, { runExtraction: noExtraction })).rejects.toThrow(/not found/i);
  });
});
