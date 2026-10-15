/**
 * Checks DATABASE_URL before migrations and explains common mistakes without printing the password.
 * Usage: tsx scripts/db-check.ts
 */
import "dotenv/config";
import postgres from "postgres";

const raw = process.env.DATABASE_URL;
if (!raw) {
  console.error("db-check: DATABASE_URL is not set for this environment (check that it is enabled for Production in Vercel).");
  process.exit(1);
}

const problems: string[] = [];
if (raw !== raw.trim()) problems.push("the value starts or ends with a space or line break");
if (/\s/.test(raw.trim())) problems.push("the value contains a space or line break in the middle (copied across two lines?)");
if (/[[\]]/.test(raw)) problems.push("the value still contains [ or ] (remove the brackets around the password)");
if (/YOUR-PASSWORD/i.test(raw)) problems.push("the value still contains the placeholder YOUR-PASSWORD");
if ((raw.match(/@/g) ?? []).length > 1) problems.push("the value contains more than one @ (the password contains @, which must be written as %40)");

// Find the password between "user:" and the last "@" so special characters can be reported.
const auth = raw.slice(raw.indexOf("//") + 2, raw.lastIndexOf("@"));
const rawPassword = auth.includes(":") ? auth.slice(auth.indexOf(":") + 1) : "";
const special = [...new Set(rawPassword.replace(/%[0-9A-Fa-f]{2}/g, "").replace(/[A-Za-z0-9]/g, ""))];
if (special.some((c) => "#?/@:".includes(c))) problems.push(`the password contains characters that break a URL (${special.join(" ")}). Use only letters and digits`);

let parsed: URL | null = null;
try {
  parsed = new URL(raw.trim());
} catch {
  problems.push("the value is not a valid URL");
}

if (parsed) {
  const password = decodeURIComponent(parsed.password);
  console.log("db-check: DATABASE_URL as Vercel sees it (password hidden):");
  console.log(`  user:     ${decodeURIComponent(parsed.username)}`);
  console.log(`  host:     ${parsed.hostname}`);
  console.log(`  port:     ${parsed.port}`);
  console.log(`  database: ${parsed.pathname.slice(1)}`);
  console.log(`  password: ${password.length} characters, ${special.length ? `special characters: ${special.join(" ")}` : "letters/digits only"}`);
  if (parsed.hostname.includes("pooler.supabase.com") && !decodeURIComponent(parsed.username).startsWith("postgres.")) {
    problems.push("with the Supabase pooler the user must be postgres.<project-ref>");
  }
  if (!password) problems.push("the password is empty");
}

for (const p of problems) console.error(`db-check: problem: ${p}`);
if (!parsed) process.exit(1);

const url = raw.trim();
const sql = postgres(url, { max: 1, prepare: !url.includes(":6543"), connect_timeout: 15, onnotice: () => {} });
sql`SELECT 1`
  .then(() => console.log("db-check: database connection OK"))
  .catch((err: { code?: string; message?: string }) => {
    console.error(`db-check: connection failed: ${err.code ?? ""} ${err.message ?? err}`);
    if (err.code === "28P01") {
      console.error("db-check: the password does not match the one set in Supabase. Compare the password length above with the password you set.");
    }
    process.exitCode = 1;
  })
  .finally(() => sql.end());
