"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Markdown } from "@/components/Markdown";
import { confirmOrderFromChat } from "@/app/actions/chat";
import type { ChatCitation, ChatMessage, ChatPendingAction } from "./types";

const AUTHORITY_SHORT: Record<number, string> = { 1: "IFU / Regulatory", 2: "Protocol", 3: "Peer-reviewed", 4: "Training", 5: "Case study", 6: "Distributor", 7: "Commercial" };

export function ChatClient({
  conversationId: initialId,
  initialMessages,
  orderStatuses,
  caseId,
  initialPrompt,
  userFirstName,
}: {
  conversationId: string | null;
  initialMessages: ChatMessage[];
  orderStatuses: Record<string, string>;
  caseId?: string | null;
  initialPrompt?: string;
  userFirstName: string;
}) {
  const router = useRouter();
  const [conversationId, setConversationId] = useState(initialId);
  const [messages, setMessages] = useState<ChatMessage[]>(initialMessages);
  const [input, setInput] = useState(initialPrompt ?? "");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => bottom.current?.scrollIntoView({ behavior: "smooth" }), [messages, sending]);

  async function send() {
    const content = input.trim();
    if (!content || sending) return;
    setError(null);
    setSending(true);
    const optimistic: ChatMessage = { id: `local-${Date.now()}`, role: "user", content, sources: [], pendingActions: [], createdAt: new Date().toISOString() };
    setMessages((m) => [...m, optimistic]);
    setInput("");
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content, conversationId, caseId: conversationId ? null : caseId ?? null }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Request failed");
      const msg = body.message;
      setMessages((m) => [
        ...m,
        { id: msg.id, role: "assistant", content: msg.content, sources: msg.sources, pendingActions: msg.pendingActions, error: msg.error, createdAt: msg.createdAt },
      ]);
      if (!conversationId) {
        setConversationId(msg.conversationId);
        router.replace(`/chat/${msg.conversationId}`);
      } else {
        router.refresh();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed");
      setMessages((m) => m.filter((x) => x.id !== optimistic.id));
      setInput(content);
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex-1 overflow-y-auto px-6 py-6">
        <div className="mx-auto max-w-3xl space-y-5">
          {messages.length === 0 && <Welcome name={userFirstName} onPick={(p) => setInput(p)} />}
          {messages.map((m) => (
            <MessageView key={m.id} m={m} conversationId={conversationId} orderStatuses={orderStatuses} />
          ))}
          {sending && (
            <div className="flex items-center gap-2 text-sm text-muted">
              <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-brand" /> Checking approved sources and your records…
            </div>
          )}
          <div ref={bottom} />
        </div>
      </div>
      <div className="border-t border-line bg-white px-6 py-4">
        <div className="mx-auto max-w-3xl">
          {error && <p className="mb-2 text-sm text-danger">{error}</p>}
          <div className="flex items-end gap-2">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
              rows={Math.min(6, Math.max(1, input.split("\n").length))}
              placeholder="Ask about a case, a product, evidence, stock or an order…"
              className="input resize-none py-2.5"
              maxLength={8000}
              aria-label="Message"
            />
            <button onClick={() => void send()} disabled={sending || !input.trim()} className="btn-primary h-10">Send</button>
          </div>
          <p className="mt-1.5 text-[11px] text-muted">Supports, never replaces, your clinical judgement. Product guidance comes only from approved BioChange sources.</p>
        </div>
      </div>
    </div>
  );
}

function Welcome({ name, onPick }: { name: string; onPick: (p: string) => void }) {
  const prompts = [
    "I have a 7mm pocket on 204 and I'm doing an open flap.",
    "How many ReGum do I have left?",
    "Is there evidence that ReGum improves periodontal regeneration?",
    "Which cases are due for follow-up?",
  ];
  return (
    <div className="py-10 text-center">
      <h2 className="text-lg font-semibold">Hello {name}. What are you working on?</h2>
      <p className="mt-1 text-sm text-muted">Clinical questions, a case in progress, follow-ups, stock or reordering.</p>
      <div className="mx-auto mt-6 grid max-w-xl gap-2 sm:grid-cols-2">
        {prompts.map((p) => (
          <button key={p} onClick={() => onPick(p)} className="card px-3 py-2.5 text-left text-sm hover:border-brand">{p}</button>
        ))}
      </div>
    </div>
  );
}

function MessageView({ m, conversationId, orderStatuses }: { m: ChatMessage; conversationId: string | null; orderStatuses: Record<string, string> }) {
  if (m.role === "system") {
    return <div className="text-center text-xs text-muted">— {m.content} —</div>;
  }
  if (m.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-brand px-4 py-2.5 text-sm text-white">{m.content}</div>
      </div>
    );
  }
  const byLabel = new Map(m.sources.map((s) => [s.label, s]));
  return (
    <div className="max-w-[92%]">
      <div className={`rounded-2xl rounded-bl-md border px-4 py-3 text-sm leading-relaxed ${m.error ? "border-warn/40 bg-warn-soft" : "border-line bg-white"}`}>
        <Markdown text={m.content} renderCitation={(label) => <CitationChip c={byLabel.get(label)} label={label} />} />
      </div>
      {m.sources.length > 0 && (
        <div className="mt-2 space-y-1">
          {m.sources.map((s) => (
            <div key={s.label} className="flex flex-wrap items-center gap-2 text-xs text-muted">
              <span className="badge bg-brand-soft text-brand-dark">{s.label}</span>
              <span className="font-medium text-ink">{s.title}</span>
              {s.section && <span>· {s.section}</span>}
              {s.page != null && <span>· p.{s.page}</span>}
              <span className="badge bg-canvas">{AUTHORITY_SHORT[s.authorityLevel] ?? `Level ${s.authorityLevel}`}</span>
              <Link href={`/sources/${s.sourceId}?chunk=${s.chunkId}`} target="_blank" className="text-brand hover:underline">View source</Link>
            </div>
          ))}
        </div>
      )}
      {m.pendingActions.map((a, i) => (
        <PendingActionCard key={i} a={a} conversationId={conversationId} status={a.type === "confirm_order" ? orderStatuses[a.orderId] : undefined} />
      ))}
    </div>
  );
}

function CitationChip({ c, label }: { c?: ChatCitation; label: string }) {
  if (!c) return <span className="text-muted">[{label}]</span>;
  return (
    <Link
      href={`/sources/${c.sourceId}?chunk=${c.chunkId}`}
      target="_blank"
      title={`${c.title}${c.section ? ` — ${c.section}` : ""}\n\n${c.excerpt}`}
      className="mx-0.5 inline-flex -translate-y-px items-center rounded bg-brand-soft px-1 text-[11px] font-semibold text-brand-dark hover:bg-brand hover:text-white"
    >
      {label}
    </Link>
  );
}

function PendingActionCard({ a, conversationId, status }: { a: ChatPendingAction; conversationId: string | null; status?: string }) {
  const [result, setResult] = useState<{ ok?: string; error?: string } | null>(null);
  const [pending, start] = useTransition();
  if (a.type === "open_case") {
    return (
      <div className="mt-2 flex items-center justify-between rounded-xl border border-line bg-white px-4 py-2.5 text-sm">
        <span>Case saved: <span className="font-medium">{a.summary}</span></span>
        <Link href={`/cases/${a.caseId}`} className="text-brand hover:underline">Open case</Link>
      </div>
    );
  }
  const done = result?.ok || (status && status !== "draft");
  return (
    <div className="mt-2 rounded-xl border border-brand/30 bg-brand-soft/60 px-4 py-3 text-sm">
      <div className="text-xs font-semibold uppercase tracking-wide text-brand-dark">Draft order — not yet recorded</div>
      <div className="mt-1">{a.summary}</div>
      {done ? (
        <div className="mt-2 text-ok">{result?.ok ?? `Order ${status}.`}</div>
      ) : (
        <div className="mt-2 flex items-center gap-3">
          <button
            className="btn-primary"
            disabled={pending}
            onClick={() =>
              start(async () => {
                const r = await confirmOrderFromChat(a.orderId, conversationId);
                setResult(r ?? null);
              })
            }
          >
            {pending ? "Recording…" : "Confirm & record order"}
          </button>
          <Link href="/orders" className="text-brand hover:underline">Edit in Orders</Link>
          {result?.error && <span className="text-danger">{result.error}</span>}
        </div>
      )}
      <p className="mt-2 text-xs text-muted">Recording an order does not purchase anything automatically; place it with your distributor as usual.</p>
    </div>
  );
}
