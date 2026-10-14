import { redirect } from "next/navigation";
import { getMfaPendingUser, getSessionUser } from "@/lib/auth/session";
import { googleEnabled } from "@/lib/auth/identity";
import { LoginForm } from "./LoginForm";
import { Logo } from "@/components/Logo";

const ERRORS: Record<string, string> = {
  google: "Google sign-in could not be completed. Please try again or use an email link.",
  not_invited: "This account is not registered for BioChange. Contact BioChange for an invitation.",
};

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  if (await getSessionUser()) redirect("/");
  if (await getMfaPendingUser()) redirect("/login/mfa");
  const { error } = await searchParams;
  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center text-center">
          <Logo size={40} />
          <h1 className="mt-3 text-lg font-semibold">BioChange Vet Companion</h1>
          <p className="mt-1 text-sm text-muted">Clinical and product companion for regenerative veterinary dentistry</p>
        </div>
        <div className="card p-6">
          {error && ERRORS[error] && <p className="mb-4 rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">{ERRORS[error]}</p>}
          <LoginForm google={googleEnabled()} />
        </div>
        <p className="mt-4 text-center text-xs text-muted">For invited veterinary professionals and BioChange staff.</p>
      </div>
    </main>
  );
}
