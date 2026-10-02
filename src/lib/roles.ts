export const ROLES = ["veterinarian", "clinic_admin", "biochange_admin", "biochange_medical"] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  veterinarian: "Veterinarian",
  clinic_admin: "Clinic Admin",
  biochange_admin: "BioChange Admin",
  biochange_medical: "BioChange Medical",
};

/** Roles that work inside a clinic (cases, inventory, orders). */
export function isClinicRole(role: Role): boolean {
  return role === "veterinarian" || role === "clinic_admin";
}

/** BioChange staff roles (knowledge base, escalations, analytics). */
export function isBioChangeStaff(role: Role): boolean {
  return role === "biochange_admin" || role === "biochange_medical";
}
