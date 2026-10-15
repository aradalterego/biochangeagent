"use client";

import { ErrorScreen } from "@/components/ErrorScreen";

export default function AppError(props: { error: Error & { digest?: string }; reset: () => void }) {
  return <ErrorScreen {...props} />;
}
