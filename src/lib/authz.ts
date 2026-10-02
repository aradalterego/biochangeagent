import type { Role } from "./roles";
import { isBioChangeStaff, isClinicRole } from "./roles";

/**
 * The identity every domain operation is performed as. Built by the server from the
 * authenticated session (web) or a verified channel identity (future channels) — never
 * from anything the model or the client supplies.
 */
export interface Actor {
  userId: string;
  role: Role;
  clinicId: string | null;
}

export class AuthorizationError extends Error {
  constructor(message = "Not authorised") {
    super(message);
    this.name = "AuthorizationError";
  }
}

export class NotFoundError extends Error {
  constructor(message = "Not found") {
    super(message);
    this.name = "NotFoundError";
  }
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

/** Clinic operational data (cases, inventory, orders) may be changed only by members of that clinic. */
export function assertClinicWrite(actor: Actor, clinicId: string): void {
  if (!isClinicRole(actor.role) || !actor.clinicId || actor.clinicId !== clinicId) {
    throw new AuthorizationError("You can only change data for your own clinic.");
  }
}

/** Clinic data may be read by its members, and by BioChange admins for account support. */
export function assertClinicRead(actor: Actor, clinicId: string): void {
  if (actor.role === "biochange_admin") return;
  assertClinicWrite(actor, clinicId);
}

/** The actor's own clinic, required for clinic-scoped operations. */
export function requireClinic(actor: Actor): string {
  if (!isClinicRole(actor.role) || !actor.clinicId) {
    throw new AuthorizationError("This action requires a clinic account.");
  }
  return actor.clinicId;
}

export function assertKnowledgeManager(actor: Actor): void {
  if (!isBioChangeStaff(actor.role)) throw new AuthorizationError("Knowledge management requires a BioChange staff role.");
}

export function assertEscalationHandler(actor: Actor): void {
  if (!isBioChangeStaff(actor.role)) throw new AuthorizationError("Medical support requires a BioChange staff role.");
}

export function assertBioChangeAdmin(actor: Actor): void {
  if (actor.role !== "biochange_admin") throw new AuthorizationError("Requires BioChange Admin.");
}

export function actorFromSession(user: { id: string; role: Role; clinicId: string | null }): Actor {
  return { userId: user.id, role: user.role, clinicId: user.clinicId };
}
