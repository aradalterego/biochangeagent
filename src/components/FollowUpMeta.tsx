import { Badge } from "@/components/ui";
import { fmtDate } from "@/lib/format";

/** Origin and reminder state of a follow-up (shown on the vet case page and the dashboard). */
export function FollowUpMeta({ f }: { f: { kind?: unknown; reminder_status?: unknown; reminder_sent_at?: unknown } }) {
  return (
    <span className="ml-2 inline-flex flex-wrap items-center gap-1 align-middle">
      {f.kind === "default" && <Badge>automatic</Badge>}
      {f.reminder_status === "sent" && <span className="text-xs text-muted">reminder emailed {fmtDate(f.reminder_sent_at as Date | null)}</span>}
      {f.reminder_status === "failed" && <Badge tone="danger">reminder failed</Badge>}
      {f.reminder_status === "skipped" && <span className="text-xs text-muted">no reminder (no active recipient)</span>}
    </span>
  );
}
