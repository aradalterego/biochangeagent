"use client";

import { useActionState } from "react";
import { verifyMfaAction } from "@/app/actions/auth";

export function MfaForm() {
  const [state, action, pending] = useActionState(verifyMfaAction, undefined);
  return (
    <form action={action} className="space-y-3">
      <input name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]{6,7}" maxLength={7} required placeholder="123 456" className="input text-center text-lg tracking-widest" aria-label="Verification code" />
      {state?.error && <p className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">{state.error}</p>}
      <button className="btn-primary w-full" disabled={pending}>{pending ? "Checking…" : "Verify"}</button>
    </form>
  );
}
