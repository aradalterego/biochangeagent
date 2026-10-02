import "server-only";
import { sql } from "@/lib/db";
import { NotFoundError, ValidationError } from "@/lib/authz";

export interface Product {
  id: string;
  name: string;
  product_family: string;
  variant: string | null;
  sku: string;
  form: string | null;
  units_per_package: number;
  active: boolean;
  market: string;
  description: string | null;
  is_placeholder_sku: boolean;
}

export async function listProducts(): Promise<Product[]> {
  return sql<Product[]>`SELECT * FROM products WHERE active ORDER BY product_family, variant NULLS FIRST, sku`;
}

/**
 * Resolves a product reference from the model or a form ("ReGum", "regum vet large", a SKU or an id).
 * Returns the single match, or throws a ValidationError listing the options when ambiguous.
 */
export async function resolveProduct(ref: string | null | undefined): Promise<Product> {
  if (!ref?.trim()) throw new ValidationError("Which product? Please specify the product (and variant if applicable).");
  const products = await listProducts();
  const needle = ref.trim().toLowerCase();
  const byId = products.find((p) => p.id === ref || p.sku.toLowerCase() === needle);
  if (byId) return byId;
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const n = norm(ref);
  const exact = products.filter((p) => norm(`${p.product_family}${p.variant ?? ""}`) === n || norm(p.name) === n);
  if (exact.length === 1) return exact[0];
  const family = products.filter((p) => n.includes(norm(p.product_family)) || norm(p.product_family).includes(n));
  const narrowed = family.filter((p) => p.variant && n.includes(norm(p.variant)));
  if (narrowed.length === 1) return narrowed[0];
  if (family.length === 1) return family[0];
  if (family.length > 1) {
    throw new ValidationError(
      `"${ref}" matches several variants: ${family.map((p) => `${p.name} (SKU ${p.sku})`).join("; ")}. Ask which one.`,
    );
  }
  throw new NotFoundError(`No active product matches "${ref}". Known products: ${products.map((p) => p.name).join(", ")}.`);
}
