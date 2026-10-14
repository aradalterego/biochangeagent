"use client";

import { useActionState } from "react";
import { confirmLinkAction } from "@/app/actions/auth";

export function ConfirmForm({ token, tokenHash, type }: { token: string; tokenHash: string; type: string }) {
  const [state, action, pending] = useActionState(confirmLinkAction, undefined);
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="token" value={token} />
      <input type="hidden" name="token_hash" value={tokenHash} />
      <input type="hidden" name="type" value={type} />
      <p className="text-sm text-muted">Press continue to finish signing in on this device.</p>
      {state?.error && (
        <p className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
          {state.error} <a href="/login" className="underline">Back to sign in</a>
        </p>
      )}
      <button className="btn-primary w-full" disabled={pending}>{pending ? "Signing in…" : "Continue"}</button>
    </form>
  );
}
