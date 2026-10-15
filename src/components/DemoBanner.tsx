import { isDemoEnvironment } from "@/lib/env";

/** Shown on every page of a demo deployment so sample data is never mistaken for real data. */
export function DemoBanner() {
  if (!isDemoEnvironment()) return null;
  return (
    <div className="bg-warn-soft px-4 py-1.5 text-center text-xs font-medium text-warn">
      Demo environment: sample accounts and data. Do not enter real client or patient information.
    </div>
  );
}
