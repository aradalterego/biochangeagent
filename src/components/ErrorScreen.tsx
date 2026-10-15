"use client";

import { startTransition } from "react";
import { useRouter } from "next/navigation";

/** Friendly replacement for a crashed page: retries the same page without a full reload. */
export function ErrorScreen({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const router = useRouter();
  const retry = () =>
    startTransition(() => {
      // Re-fetch the server components, then re-render the failed segment.
      router.refresh();
      reset();
    });
  return (
    <div className="flex h-full min-h-[60vh] items-center justify-center px-4">
      <div className="card max-w-md p-6 text-center">
        <h2 className="text-lg font-semibold">Something went wrong loading this page</h2>
        <p className="mt-2 text-sm text-muted">
          Your work has been saved. This is usually temporary. Please try again.
        </p>
        <div className="mt-5 flex justify-center gap-2">
          <button onClick={retry} className="btn-primary">Try again</button>
          <a href="/" className="btn-secondary">Go to home</a>
        </div>
        {error.digest && <p className="mt-4 text-[11px] text-muted">Reference: {error.digest}</p>}
      </div>
    </div>
  );
}
