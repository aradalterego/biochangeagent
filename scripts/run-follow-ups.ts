/** Runs the follow-up reminder job and the reminder-rule emails once (for hosts without Vercel Cron, or manually). */
import "dotenv/config";
import { closeDb } from "@/lib/db";
import { runFollowUpReminders } from "@/server/domain/followUpReminders";
import { runEngagementJobs } from "@/server/domain/engagement";

(async () => {
  const r = await runFollowUpReminders();
  console.log(`Follow-up reminders: ${r.enqueued} queued, ${r.sent} sent, ${r.failed} failed, ${r.skipped} skipped.`);
  const e = await runEngagementJobs();
  console.log(`Reminder-rule emails: ${e.enqueued} queued, ${e.sent} sent, ${e.failed} failed, ${e.skipped} skipped.`);
})()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
