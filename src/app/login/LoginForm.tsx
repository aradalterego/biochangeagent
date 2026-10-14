"use client";

import { useActionState, useState } from "react";
import { passwordLoginAction, requestLinkAction } from "@/app/actions/auth";

export function LoginForm({ google }: { google: boolean }) {
  const [linkState, linkAction, linkPending] = useActionState(requestLinkAction, undefined);
  const [pwState, pwAction, pwPending] = useActionState(passwordLoginAction, undefined);
  const [showPassword, setShowPassword] = useState(false);

  return (
    <div className="space-y-5">
      <form action={linkAction} className="space-y-3">
        <div>
          <label className="label" htmlFor="link-email">Email</label>
          <input id="link-email" name="email" type="email" autoComplete="email" required className="input" />
        </div>
        {linkState?.error && <p className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">{linkState.error}</p>}
        {linkState?.ok && <p className="rounded-lg bg-ok-soft px-3 py-2 text-sm text-ok">{linkState.ok}</p>}
        <button className="btn-primary w-full" disabled={linkPending}>{linkPending ? "Sending…" : "Email me a sign-in link"}</button>
      </form>

      {google && (
        <a href="/auth/google" className="btn-secondary w-full">Continue with Google</a>
      )}

      <div className="border-t border-line pt-4">
        {!showPassword ? (
          <button type="button" className="text-xs text-brand hover:underline" onClick={() => setShowPassword(true)}>BioChange staff: sign in with password</button>
        ) : (
          <form action={pwAction} className="space-y-3">
            <div>
              <label className="label" htmlFor="email">Email</label>
              <input id="email" name="email" type="email" autoComplete="username" required className="input" />
            </div>
            <div>
              <label className="label" htmlFor="password">Password</label>
              <input id="password" name="password" type="password" autoComplete="current-password" required className="input" />
            </div>
            {pwState?.error && <p className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">{pwState.error}</p>}
            <button className="btn-secondary w-full" disabled={pwPending}>{pwPending ? "Signing in…" : "Sign in"}</button>
          </form>
        )}
      </div>
    </div>
  );
}
