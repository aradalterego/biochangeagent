import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth/session";
import { actorFromSession } from "@/lib/authz";
import { submitOfferAction } from "@/app/actions/engagement";
import { ActionForm } from "@/components/ActionForm";
import { Page, PageHeader, Section } from "@/components/ui";
import { fmtDate } from "@/lib/format";
import { getOfferForUser } from "@/server/domain/engagement";

/** The veterinarian's short feedback page, linked from a reminder email. Only their own offer opens. */
export default async function OfferPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  const offer = await getOfferForUser(actorFromSession(user), id).catch(() => null);
  if (!offer) notFound();
  const product = offer.product ?? "BioChange products";
  const expired = offer.status === "open" && offer.expires_at.getTime() < Date.now();
  return (
    <Page>
      <PageHeader title={`Your feedback on ${product}`} subtitle={`Three short questions. If you are using ${product} now, you get ${offer.discount_percent}% off your next order.`} />
      <Section title="Feedback">
        {offer.status === "completed" ? (
          <div className="space-y-2 text-sm">
            <p>Thank you for your feedback!</p>
            <p>Your discount code: <span className="rounded bg-brand-soft px-2 py-1 font-mono font-semibold text-brand-dark">{offer.discount_code}</span></p>
            <p className="text-muted">{offer.discount_percent}% off your next order. Mention the code when you order from BioChange or your distributor. We also emailed it to you.</p>
          </div>
        ) : offer.status === "not_eligible" ? (
          <p className="text-sm">Thank you for your feedback! It helps us improve.</p>
        ) : expired ? (
          <p className="text-sm text-muted">This offer expired on {fmtDate(offer.expires_at)}.</p>
        ) : (
          <ActionForm action={submitOfferAction.bind(null, offer.id)} submitLabel="Send feedback">
            <div className="space-y-4">
              <fieldset>
                <legend className="label">1. Are you using {product} in your practice now?</legend>
                <div className="flex gap-4 pt-1 text-sm">
                  <label className="flex items-center gap-1.5"><input type="radio" name="using_product" value="yes" required /> Yes</label>
                  <label className="flex items-center gap-1.5"><input type="radio" name="using_product" value="no" required /> No</label>
                </div>
              </fieldset>
              <fieldset>
                <legend className="label">2. How satisfied are you with {product}?</legend>
                <div className="flex gap-3 pt-1 text-sm">
                  {[1, 2, 3, 4, 5].map((n) => <label key={n} className="flex items-center gap-1"><input type="radio" name="rating" value={n} required /> {n}</label>)}
                </div>
              </fieldset>
              <div>
                <label className="label">3. In a sentence or two: how is it working for you?</label>
                <textarea name="comment" required minLength={3} maxLength={2000} rows={4} className="input" />
              </div>
            </div>
          </ActionForm>
        )}
        <p className="mt-4 text-xs text-muted">Valid until {fmtDate(offer.expires_at)}. Please do not include patient-identifying details.</p>
      </Section>
    </Page>
  );
}
