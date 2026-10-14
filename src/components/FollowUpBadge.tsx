import { Badge } from "@/components/ui";

const TONE = { overdue: "danger", missing: "danger", scheduled: "warn", completed: "ok", not_due: "neutral" } as const;
const LABEL = { overdue: "overdue", missing: "missing", scheduled: "scheduled", completed: "done", not_due: "not due" } as const;

export function FollowUpBadge({ state }: { state: keyof typeof TONE }) {
  return <Badge tone={TONE[state]}>{LABEL[state]}</Badge>;
}
