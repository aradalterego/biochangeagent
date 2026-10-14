import { Badge } from "@/components/ui";
import { fmtDateTime } from "@/lib/format";
import type { FeedbackRow } from "@/server/domain/feedback";

export function FeedbackList({ feedback, timezone }: { feedback: FeedbackRow[]; timezone: string }) {
  if (!feedback.length) return <p className="text-sm text-muted">No feedback recorded yet.</p>;
  return (
    <ul className="space-y-2">
      {feedback.map((f) => (
        <li key={f.id} className="rounded-lg border border-line px-3 py-2 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="brand">{f.phase.replace("_", "-")}</Badge>
            {f.product_name && <span className="text-muted">{f.product_name}</span>}
            {f.product_rating != null && <span>Product {f.product_rating}/5</span>}
            {f.ease_of_use_rating != null && <span>Ease of use {f.ease_of_use_rating}/5</span>}
            {f.would_use_again && <span>Would use again: {f.would_use_again}</span>}
            <span className="text-xs text-muted">· {f.author ?? "—"} · {fmtDateTime(f.created_at, timezone)}{f.source === "chat" ? " · from chat" : ""}</span>
          </div>
          {f.product_feedback && <p className="mt-1 whitespace-pre-wrap">{f.product_feedback}</p>}
          {f.usability_feedback && <p className="mt-1 whitespace-pre-wrap text-muted">Ease of use: {f.usability_feedback}</p>}
          {f.handling_notes && <p className="mt-1 whitespace-pre-wrap text-muted">Handling: {f.handling_notes}</p>}
        </li>
      ))}
    </ul>
  );
}
