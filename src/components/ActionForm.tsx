"use client";

import { useActionState, useEffect, useRef } from "react";
import type { ActionState } from "@/lib/actions";

/** Form wrapper for server actions that shows success / error messages inline. */
export function ActionForm({
  action,
  children,
  className,
  submitLabel = "Save",
  submitClassName = "btn-primary",
  resetOnSuccess,
  confirm,
}: {
  action: (prev: ActionState, fd: FormData) => Promise<ActionState>;
  children?: React.ReactNode;
  className?: string;
  submitLabel?: string;
  submitClassName?: string;
  resetOnSuccess?: boolean;
  confirm?: string;
}) {
  const [state, formAction, pending] = useActionState(action, undefined);
  const ref = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (state?.ok && resetOnSuccess) ref.current?.reset();
  }, [state, resetOnSuccess]);
  return (
    <form
      ref={ref}
      action={formAction}
      className={className}
      onSubmit={(e) => {
        if (confirm && !window.confirm(confirm)) e.preventDefault();
      }}
    >
      {children}
      <div className="mt-3 flex items-center gap-3">
        <button className={submitClassName} disabled={pending}>{pending ? "Working…" : submitLabel}</button>
        {state?.error && <span className="text-sm text-danger">{state.error}</span>}
        {state?.ok && !pending && <span className="text-sm text-ok">{state.ok}</span>}
      </div>
    </form>
  );
}
