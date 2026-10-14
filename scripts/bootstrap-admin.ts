/**
 * Creates (or resets the password of) a BioChange admin account.
 *   ADMIN_EMAIL=you@biochange.life ADMIN_NAME="Your Name" ADMIN_PASSWORD='…' npm run admin:bootstrap
 * Optional: ADMIN_ROLE=biochange_medical
 *           ADMIN_RESET_MFA=true   clears the authenticator enrolment (lost phone); the admin enrols again at next sign-in
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
  if (process.env.ADMIN_RESET_MFA === "true") {
    await sql`UPDATE users SET totp_secret_enc = NULL, totp_enabled_at = NULL, totp_last_step = NULL WHERE id = ${u.id}`;
    await sql`DELETE FROM sessions WHERE user_id = ${u.id}`;
    console.log("Two-step verification reset.");
  }
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
