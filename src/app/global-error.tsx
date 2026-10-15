"use client";

import "./globals.css";
import { ErrorScreen } from "@/components/ErrorScreen";

/** Last-resort boundary for errors in the root layouts (replaces the whole document). */
export default function GlobalError(props: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en">
      <body className="bg-canvas text-ink">
        <ErrorScreen {...props} />
      </body>
    </html>
  );
}
