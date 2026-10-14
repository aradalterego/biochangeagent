import { ConfirmForm } from "./ConfirmForm";
import { Logo } from "@/components/Logo";

/**
 * Landing page of the emailed sign-in link. The link itself does nothing: the person presses
 * "Continue", so email security scanners that open links cannot use up the one-time token.
 */
export default async function ConfirmPage({ searchParams }: { searchParams: Promise<{ token?: string; token_hash?: string; type?: string }> }) {
  const sp = await searchParams;
  const valid = Boolean(sp.token || sp.token_hash);
  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center text-center">
          <Logo size={40} />
          <h1 className="mt-3 text-lg font-semibold">Sign in to BioChange</h1>
        </div>
        <div className="card p-6">
          {valid ? (
            <ConfirmForm token={sp.token ?? ""} tokenHash={sp.token_hash ?? ""} type={sp.type ?? ""} />
          ) : (
            <p className="text-sm text-danger">This sign-in link is incomplete. <a href="/login" className="text-brand underline">Request a new one</a>.</p>
          )}
        </div>
      </div>
    </main>
  );
}
