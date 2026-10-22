import { requireRole } from "@/lib/auth/session";
import { Badge, Page, PageHeader, Section } from "@/components/ui";
import { fmtDate } from "@/lib/format";
import { listOffers } from "@/server/domain/engagement";

const TONE = { open: "warn", completed: "ok", not_eligible: "neutral" } as const;

/** Feedback-for-discount offers sent by reminder rules: answers, ratings and issued discount codes. */
export default async function OffersPage() {
  await requireRole(["biochange_admin"]);
  const offers = await listOffers();
  return (
    <Page wide>
      <PageHeader title="Feedback & discounts" subtitle="A veterinarian who uses the product now and answers the short feedback gets a discount code for the next order." />
      <Section title="Offers">
        {offers.length ? (
          <div className="overflow-x-auto">
            <table className="table">
              <thead><tr><th>Sent</th><th>Veterinarian</th><th>Product</th><th>Discount</th><th>Status</th><th>Rating</th><th>Feedback</th><th>Code</th></tr></thead>
              <tbody>
                {offers.map((o) => {
                  const expired = o.status === "open" && o.expires_at.getTime() < Date.now();
                  return (
                    <tr key={o.id}>
                      <td>{fmtDate(o.created_at)}<div className="text-xs text-muted">{o.rule ?? ""}</div></td>
                      <td>{o.vet}</td>
                      <td>{o.product ?? "—"}</td>
                      <td>{o.discount_percent}%</td>
                      <td><Badge tone={expired ? "neutral" : TONE[o.status]}>{expired ? "expired" : o.status === "not_eligible" ? "not using product" : o.status}</Badge></td>
                      <td>{o.rating ? `${o.rating}/5` : "—"}</td>
                      <td className="max-w-sm text-xs">{o.comment ?? "—"}</td>
                      <td className="font-mono text-xs">{o.discount_code ?? "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : <p className="text-sm text-muted">No offers yet. Create a reminder rule of type “Feedback for a discount”.</p>}
      </Section>
    </Page>
  );
}
