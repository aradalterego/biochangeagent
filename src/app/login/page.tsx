import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth/session";
import { LoginForm } from "./LoginForm";
import { Logo } from "@/components/Logo";

export default async function LoginPage() {
  if (await getSessionUser()) redirect("/");
  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center text-center">
          <Logo size={40} />
          <h1 className="mt-3 text-lg font-semibold">BioChange Vet Companion</h1>
          <p className="mt-1 text-sm text-muted">Clinical and product companion for regenerative veterinary dentistry</p>
        </div>
        <div className="card p-6">
          <LoginForm />
        </div>
        <p className="mt-4 text-center text-xs text-muted">For veterinary professionals. Access is provided by BioChange or your clinic administrator.</p>
      </div>
    </main>
  );
}
