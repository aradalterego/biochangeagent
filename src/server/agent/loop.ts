import "server-only";
import type OpenAI from "openai";
import { env } from "@/lib/env";
import { buildInstructions } from "./systemPrompt";
import { executeTool, toolDeclarations, type TurnState } from "./tools";
import type { HistoryMessage } from "./context";

type ResponsesAPI = Pick<OpenAI["responses"], "create">;
export interface LLMClient {
  responses: ResponsesAPI;
}

type InputItem = OpenAI.Responses.ResponseInputItem;

const MAX_TOOL_ROUNDS = 8;
/** Whole-turn budget, below the route's maxDuration so the user always gets a response. */
const TURN_DEADLINE_MS = 100_000;

export interface AgentRunResult {
  text: string;
  rounds: number;
  model: string;
}

function isReasoningModel(model: string) {
  return /^(o\d|gpt-5|gpt-6)/.test(model);
}

/**
 * The central agent loop (OpenAI Responses API + function calling).
 *
 *   LLM understands → backend validates → backend executes.
 *
 * The model only ever *requests* tool calls; every call is executed by `executeTool`, which
 * authorises it against the server-side actor. Responses are not stored at OpenAI
 * (store: false); the application database is the canonical conversation archive.
 */
export async function runAgent(client: LLMClient, state: TurnState, ctx: { contextBlock: string; history: HistoryMessage[] }): Promise<AgentRunResult> {
  const model = env().OPENAI_MODEL;
  const reasoning = isReasoningModel(model);
  const effort = env().OPENAI_REASONING_EFFORT;
  const input: InputItem[] = [
    { role: "developer", content: ctx.contextBlock },
    ...ctx.history.map((m) =>
      // App events (e.g. "Order recorded") are passed as developer notes, not as user speech.
      (m.role === "system"
        ? { role: "developer", content: `[app event] ${m.content}` }
        : // Citation labels are numbered per turn; drop old ones so they can't be confused with this turn's.
          { role: m.role, content: m.role === "assistant" ? m.content.replace(/\s*\[S\d+(?:\s*,\s*S\d+)*\]/g, "") : m.content }) as InputItem,
    ),
    { role: "user", content: state.userText },
  ];
  const tools = toolDeclarations();

  const deadline = Date.now() + TURN_DEADLINE_MS;
  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    const finalRound = round === MAX_TOOL_ROUNDS;
    const remaining = deadline - Date.now();
    if (remaining < 5_000) throw new Error("Agent turn exceeded its time budget");
    const res = await client.responses.create({
      model,
      instructions: buildInstructions(),
      input,
      tools,
      tool_choice: finalRound ? "none" : "auto",
      parallel_tool_calls: true,
      store: false,
      ...(reasoning ? { include: ["reasoning.encrypted_content"] as OpenAI.Responses.ResponseIncludable[] } : {}),
      ...(reasoning && effort ? { reasoning: { effort } } : {}),
    }, { timeout: remaining, maxRetries: remaining > 60_000 ? 1 : 0 });

    if (res.error) throw new Error(`Model error: ${res.error.message}`);
    const calls = res.output.filter((o): o is OpenAI.Responses.ResponseFunctionToolCall => o.type === "function_call");
    if (!calls.length || finalRound) {
      const text = (res.output_text ?? "").trim();
      if (!text) throw new Error(res.incomplete_details?.reason ? `Response incomplete: ${res.incomplete_details.reason}` : "Empty model response");
      return { text, rounds: round + 1, model };
    }

    input.push(...(res.output as unknown as InputItem[]));
    // Execute sequentially: calls may depend on each other (e.g. create case, then record usage).
    for (const call of calls) {
      const output = await executeTool(call.name, call.arguments, state);
      input.push({ type: "function_call_output", call_id: call.call_id, output: JSON.stringify(output ?? null) });
    }
  }
  throw new Error("Agent exceeded tool rounds");
}
