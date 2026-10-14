import { redirect } from "next/navigation";
import QRCode from "qrcode";
import { getMfaPendingUser, getSessionUser } from "@/lib/auth/session";
import { getOrStartMfaEnrollment } from "@/lib/auth/signin";
import { totpUri } from "@/lib/auth/totp";
import { logoutAction } from "@/app/actions/auth";
import { Logo } from "@/components/Logo";
import { MfaForm } from "./MfaForm";

/** Second factor for BioChange staff: enrol an authenticator app once, then enter a code at each sign-in. */
export default async function MfaPage() {
  if (await getSessionUser()) redirect("/");
  const user = await getMfaPendingUser();
  if (!user) redirect("/login");
  const state = await getOrStartMfaEnrollment(user.id);
  const uri = state.pendingSecret ? totpUri(state.pendingSecret, user.email) : null;
  const qr = uri ? await QRCode.toString(uri, { type: "svg", margin: 1, width: 200 }) : null;
  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center text-center">
          <Logo size={40} />
          <h1 className="mt-3 text-lg font-semibold">Two-step verification</h1>
          <p className="mt-1 text-sm text-muted">Required for BioChange staff accounts.</p>
        </div>
        <div className="card space-y-4 p-6">
          {state.enrolled ? (
            <p className="text-sm">Enter the 6-digit code from your authenticator app.</p>
          ) : (
            <>
              <p className="text-sm">Scan this code with an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password…), then enter the 6-digit code it shows.</p>
              {/* QR SVG generated on the server from a fixed library; contains no user-controlled markup. */}
              {qr && <div className="mx-auto w-[200px]" dangerouslySetInnerHTML={{ __html: qr }} />}
              <details className="text-xs text-muted">
                <summary className="cursor-pointer">Can&apos;t scan? Enter the key manually</summary>
                <code className="mt-2 block break-all rounded bg-canvas px-2 py-1 font-mono text-ink">{state.pendingSecret}</code>
              </details>
            </>
          )}
          <MfaForm />
          <form action={logoutAction}>
            <button className="text-xs text-brand hover:underline">Cancel and sign out</button>
          </form>
        </div>
      </div>
    </main>
  );
}
