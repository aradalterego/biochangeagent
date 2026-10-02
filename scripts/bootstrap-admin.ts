/**
 * Creates (or resets the password of) a BioChange admin account.
 *   ADMIN_EMAIL=you@biochange.life ADMIN_NAME="Your Name" ADMIN_PASSWORD='…' npm run admin:bootstrap
 * Optional: ADMIN_ROLE=biochange_medical
 */
import "dotenv/config";
import { sql, closeDb } from "@/lib/db";
import { hashPassword, passwordProblems } from "@/lib/auth/password";

async function main() {
  const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD;
  const name = process.env.ADMIN_NAME?.trim() || "BioChange Admin";
  const role = process.env.ADMIN_ROLE === "biochange_medical" ? "biochange_medical" : "biochange_admin";
  if (!email || !password) throw new Error("Set ADMIN_EMAIL and ADMIN_PASSWORD.");
  const problem = passwordProblems(password);
  if (problem) throw new Error(problem);
  const hash = await hashPassword(password);
  const [u] = await sql<{ id: string }[]>`
    INSERT INTO users (email, name, role, password_hash) VALUES (${email}, ${name}, ${role}, ${hash})
    ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, role = EXCLUDED.role, active = true
    RETURNING id`;
  await sql`INSERT INTO audit_log (user_id, action, entity_type, entity_id, tool, input_summary, result)
            VALUES (${u.id}, 'admin.bootstrap', 'user', ${u.id}, 'system', ${`${role} ${email}`}, 'success')`;
  console.log(`${role} ready: ${email}`);
}

main()
  .catch((e) => {
    console.error(e.message ?? e);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
