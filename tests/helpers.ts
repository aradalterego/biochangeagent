import type OpenAI from "openai";
import { sql } from "@/lib/db";
import type { Actor } from "@/lib/authz";
import type { LLMClient } from "@/server/agent/loop";

export async function actorFor(email: string): Promise<Actor> {
  const [u] = await sql<{ id: string; role: Actor["role"]; clinic_id: string | null }[]>`SELECT id, role, clinic_id FROM users WHERE email = ${email}`;
  if (!u) throw new Error(`no user ${email}`);
  return { userId: u.id, role: u.role, clinicId: u.clinic_id };
}

type Input = OpenAI.Responses.ResponseInputItem[];
export type Step = (input: Input) => { calls?: { name: string; args: Record<string, unknown> }[]; text?: string };

/**
 * A scripted stand-in for the OpenAI Responses API. Each step sees the full input
 * (context, history, previous tool outputs) and returns tool calls or final text,
 * so tests exercise the real backend: context building, tool execution, authorisation,
 * persistence and audit.
 */
export function scriptedClient(steps: Step[]): LLMClient & { requests: unknown[] } {
  let i = 0;
  const requests: unknown[] = [];
  return {
    requests,
    responses: {
      create: (async (params: { input: Input }) => {
        requests.push(params);
        const step = steps[i++];
        if (!step) throw new Error("script exhausted");
        const r = step(params.input);
        const output = (r.calls ?? []).map((c, n) => ({
          type: "function_call",
          id: `fc_${i}_${n}`,
          call_id: `call_${i}_${n}`,
          name: c.name,
          arguments: JSON.stringify(c.args),
          status: "completed",
        }));
        if (r.text) output.push({ type: "message", id: `msg_${i}`, role: "assistant", status: "completed", content: [{ type: "output_text", text: r.text, annotations: [] }] } as never);
        return { id: `resp_${i}`, output, output_text: r.text ?? "", error: null, incomplete_details: null };
      }) as unknown as LLMClient["responses"]["create"],
    },
  };
}

/** Last function_call_output for a tool in the model input, parsed. */
export function toolOutput(input: Input, name: string): any { // eslint-disable-line @typescript-eslint/no-explicit-any
  const calls = input.filter((x) => (x as { type?: string }).type === "function_call") as { name: string; call_id: string }[];
  const call = [...calls].reverse().find((c) => c.name === name);
  if (!call) return undefined;
  const out = input.find((x) => (x as { type?: string; call_id?: string }).type === "function_call_output" && (x as { call_id: string }).call_id === call.call_id) as { output: string } | undefined;
  return out ? JSON.parse(out.output) : undefined;
}

export function runtimeContext(input: Input): any { // eslint-disable-line @typescript-eslint/no-explicit-any
  const dev = input.find((x) => (x as { role?: string }).role === "developer") as { content: string };
  return JSON.parse(dev.content.replace(/^<runtime_context>\n/, "").replace(/\n<\/runtime_context>$/, ""));
}

export const noExtraction = () => {};
