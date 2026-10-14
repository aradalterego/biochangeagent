import { env } from "./env";

/**
 * Product areas that exist in the codebase but are outside the MVP. They stay intact
 * (code, tables, tests) and are switched on per environment with FEATURES=inventory,orders,...
 * When a feature is off its routes 404, its agent tools are not offered to the model, and
 * its server actions refuse to run.
 */
export const OPTIONAL_FEATURES = ["inventory", "orders", "adoption", "education"] as const;
export type Feature = (typeof OPTIONAL_FEATURES)[number];

export function enabledFeatures(): Set<Feature> {
  const raw = env().FEATURES.split(",").map((f) => f.trim().toLowerCase());
  if (raw.includes("all")) return new Set(OPTIONAL_FEATURES);
  return new Set(OPTIONAL_FEATURES.filter((f) => raw.includes(f)));
}

export function featureEnabled(f: Feature): boolean {
  return enabledFeatures().has(f);
}
