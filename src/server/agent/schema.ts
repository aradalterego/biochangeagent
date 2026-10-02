/**
 * Tiny builder for OpenAI strict function-calling JSON Schemas: every property is required
 * and optional values are expressed as nullable types.
 */
type Schema = Record<string, unknown>;

export const str = (description?: string): Schema => ({ type: "string", ...(description && { description }) });
export const int = (description?: string): Schema => ({ type: "integer", ...(description && { description }) });
export const num = (description?: string): Schema => ({ type: "number", ...(description && { description }) });
export const bool = (description?: string): Schema => ({ type: "boolean", ...(description && { description }) });
export const enumOf = (values: readonly string[], description?: string): Schema => ({ type: "string", enum: [...values], ...(description && { description }) });
export const arr = (items: Schema, description?: string): Schema => ({ type: "array", items, ...(description && { description }) });

export function nullable(s: Schema): Schema {
  if (Array.isArray(s.enum)) return { ...s, type: [s.type, "null"], enum: [...(s.enum as unknown[]), null] };
  return { ...s, type: [s.type as string, "null"] };
}

export function obj(properties: Record<string, Schema>): Schema {
  return { type: "object", properties, required: Object.keys(properties), additionalProperties: false };
}
