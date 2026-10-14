/** Runs the follow-up reminder job once (for hosts without Vercel Cron, or manually). */
import "dotenv/config";
import { closeDb } from "@/lib/db";
import { runFollowUpReminders } from "@/server/domain/followUpReminders";

runFollowUpReminders()
  .then((r) => console.log(`Follow-up reminders: ${r.enqueued} queued, ${r.sent} sent, ${r.failed} failed, ${r.skipped} skipped.`))
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
