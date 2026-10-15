# BioChange Vet Companion (V1)

An AI clinical, product, adoption and commercial companion for veterinarians who use BioChange regenerative dental products (ReGum Vet, MicroFoam).

It is **one persistent agent** with one memory per veterinarian. It moves between clinical guidance, case support, follow-up, inventory and reordering. Product claims come **only from approved, versioned knowledge**, never from the prompt or from general model knowledge.

```
Understand vet → understand case → retrieve approved knowledge → assist → record action
→ preserve context → support follow-up → support continued use → support reorder
```

---

## Architecture

```
Web UI (Next.js)                     future: WhatsApp / Messenger / RCS adapters
   │  POST /api/chat                          │
   └──────────────► processMessage(actor, channel, content)   ← channel-independent core
                          │
                Context Builder ── compact runtime context: user, clinic, permissions, active case,
                          │        relevant inventory, adoption state, memories, history,
                          │        pre-retrieved approved passages
                          ▼
              Central agent loop (OpenAI Responses API + function calling, store:false)
                          │  the model REQUESTS tools; it never touches the DB
                          ▼
              Tool executor ── authorises every call against the server-side actor
                          │
     ┌────────────────────┼─────────────────────────┐
     A. Approved knowledge    B. Memory / profile      C. Operational DB
     (sources, chunks,        (memories, profile,      (cases, follow-ups, inventory,
      claims, studies)         adoption, history)       orders, escalations, audit)
```

**LLM understands → backend validates → backend executes.**

| Concern | Where |
|---|---|
| Behaviour prompt (spec §26, verbatim) plus operating rules | `src/server/agent/systemPrompt.ts` |
| Context builder | `src/server/agent/context.ts` |
| Agent loop (Responses API) | `src/server/agent/loop.ts` |
| 32 tools (spec §17 plus `save_memory`, `set_active_case`, `list_products`, `get_approved_claims`, `report_knowledge_gap`) | `src/server/agent/tools.ts` |
| Channel-independent entry point `processMessage` | `src/server/agent/processMessage.ts` |
| Post-response extraction and classification (runs after the reply) | `src/server/agent/extraction.ts` |
| Knowledge: registry, parse, semantic chunking, embeddings, hybrid retrieval | `src/server/knowledge/*` |
| Domain services (each one authorises and audits) | `src/server/domain/*` |
| DB schema and RLS | `db/migrations/*.sql` |

### Key safety properties

- **Only approved knowledge is retrieved.** A new source is `pending_review` and has no index until an admin approves it. Revoked, superseded, placeholder and expired sources are never retrieved.
- **Authority hierarchy (levels 1–7)** is stored on every chunk and boosts ranking. A newly approved version supersedes the old one and removes it from retrieval.
- **Citations.** Retrieved passages get `[S#]` labels. The UI shows only the sources the answer actually cites, each with a "View source" link to the exact passage. Labels the model invents are ignored.
- **When there is no answer:** search returns nothing, the agent answers at the UNKNOWN level, a **Knowledge Gap** is logged, and Medical Support escalation is offered. If the model or the API fails, the user gets a fixed fallback message and never clinical content.
- **Cases** are created only with `user_confirmed=true`, after the vet has agreed.
- **Orders:** the agent can only create a **draft**. A draft is recorded only when the vet presses *Confirm & record order*, which is a server action authenticated by the session. Nothing is ever purchased automatically.
- **Inventory:** a *confirmed* count (counted by a person) is kept separately from *estimated* stock (derived from usage and orders). Estimates are always labelled as estimates.
- **Authorisation:** every domain operation checks the actor's clinic or role. Clinics are isolated from each other, including through agent tools. BioChange staff cannot change clinic operational data.
- **Audit log:** every mutation is logged with its tool and the chat message that triggered it. Denied tool calls are logged too.
- **Behaviour vs knowledge:** the system prompt holds no product facts (a test enforces this). Updating an IFU never requires changing the agent.

---

## MVP scope (current production path)

The MVP has four interfaces on one backend, one database, one session/authorisation layer and one agent:

| Interface | Route | Who |
|---|---|---|
| Professional agent (chat, cited answers from approved knowledge only) | `/chat` | Signed-in veterinarians |
| Clinical data capture (cases, measurements, follow-ups, structured feedback, files) | `/cases` | Veterinarians (cases are shared within a clinic) |
| Knowledge & agent policy admin | `/admin/knowledge`, `/admin/agent-policy` | BioChange staff |
| Clinical data dashboard (read-only, all clinics, CSV export) | `/dashboard` | BioChange staff |

**Out of the MVP but kept intact:** inventory, ordering, adoption journey and education. They are switched off
unless listed in `FEATURES` (e.g. `FEATURES=inventory,orders` or `FEATURES=all`). When off, their routes return 404, their agent
tools are not offered to the model (and are refused if requested) and their server actions refuse to run.

### Follow-ups and reminders

- When a case gets a treatment date, a **default follow-up** is scheduled at treatment date + 90 days (it moves if the treatment date
  changes). A follow-up the veterinarian schedules themselves replaces it. Completing a follow-up records a separate measurement.
- A daily job (`vercel.json` → `GET /api/cron/follow-ups`, protected by `CRON_SECRET`; or `npm run jobs:follow-ups`) emails the
  treating veterinarian when a follow-up is due, and once more when it is overdue. Every email goes through `notification_outbox`
  with a unique key, so a reminder is never sent twice; failed sends are retried hourly (up to 5 times). Emails contain no clinical findings.
- **Admin → Follow-up reminders**: the period (days), the overdue reminder, an on/off switch, counts and the recent emails with failures.
  A changed period applies to follow-ups created or moved afterwards.

### Sign-in and security

- **Veterinarians** sign in with a **one-time email link** (and optionally **Google**). Sign-in is **invite-only**: an identity is accepted
  only for an existing, active user created under *Admin → Users & Clinics*. The link page needs a click on "Continue", so mail scanners
  cannot use up the link. An account is bound to its identity-provider subject after first sign-in.
- **BioChange staff** sign in with an email link or password, then a **TOTP authenticator code** (enrolled on first sign-in;
  an admin can reset it, or `ADMIN_RESET_MFA=true npm run admin:bootstrap`). MFA secrets are encrypted with `AUTH_ENCRYPTION_KEY`.
- Sessions are server-side (hashed opaque token, httpOnly cookie, `Secure` except on `http://localhost`), with an absolute lifetime and an
  idle timeout (`SESSION_IDLE_MINUTES`, `STAFF_SESSION_IDLE_MINUTES`). "All devices" in the sidebar signs out everywhere.
- Authorisation is enforced in the domain services from the session's `Actor`; staff can read all clinical data but never change a clinic's records.
- Every page gets a per-request **CSP with a nonce** (`src/proxy.ts`), `frame-ancestors 'none'`, HSTS and related headers.
- Uploads are identified by content (not name or MIME), size-limited, rate-limited, stored privately under random names, and
  **images are re-encoded** (removes EXIF/GPS). Treatment files may be PDF, CSV, macro-free Excel (`.xlsx`) or text; non-images are only
  ever served as downloads. Files are never sent to the AI, embeddings or analytics.
- **Scope:** the agent only provides BioChange service (BioChange products, their veterinary dental use and evidence, the vet's cases,
  follow-ups and feedback, Medical Support). Anything else (a cake recipe, sport, coding, human medicine, other companies' products…)
  is declined in one or two sentences with no tools called and no knowledge gap logged; mixed messages get only the in-scope part
  answered. This rule is built in; *Agent policy* can narrow it further and set the exact out-of-scope wording.
  `npm run eval:scope` checks this against the real model (needs `OPENAI_API_KEY` and the demo seed).
- Text written by people or documents (knowledge passages, case records, memories) is passed to the model as a delimited data block,
  not with developer authority. Closing a case from chat needs a button press, like recording an order.
- Logs are structured JSON with redaction (no database parameters, tokens or clinical text); the audit log records which fields
  changed, not their clinical values.
- `GET /api/health` reports pass/fail for configuration and database (and, in staging/production, that no demo data is active).

---

## Requirements

- Node.js 20+ (22 recommended)
- PostgreSQL 15+ with the **pgvector** extension (Supabase includes it)
- An OpenAI API key (chat, embeddings, extraction)

## Installation (local)

```bash
npm install
cp .env.example .env            # set DATABASE_URL, OPENAI_API_KEY
npm run db:migrate              # schema + RLS
SEED_DEMO=true DEMO_PASSWORD='DemoVet2026!' npm run db:seed   # reference data + demo clinic/accounts
npm run kb:ingest-website       # fetch biochange.life pages + the ReGum study PDF (PENDING REVIEW)
npm run dev                     # http://localhost:3000
```

A quick local Postgres with pgvector: `docker run -p 5432:5432 -e POSTGRES_PASSWORD=postgres pgvector/pgvector:pg16`.

### Signing in locally

With `AUTH_PROVIDER=dev` and `EMAIL_DRIVER=log`, "Email me a sign-in link" prints the one-time link in the server log.
Demo accounts also keep their password. Staff accounts ask for an authenticator code after signing in; for a quick local demo
you can set `STAFF_MFA_REQUIRED=false` (never outside development). Generate `AUTH_ENCRYPTION_KEY` with `openssl rand -hex 32`.

### Demo accounts (seeded with `SEED_DEMO=true`; password = `DEMO_PASSWORD`)

| Email | Role |
|---|---|
| `vet@demo.biochange.test` | Veterinarian (demo clinic, with an example case, inventory and order history) |
| `clinic-admin@demo.biochange.test` | Clinic Admin |
| `admin@demo.biochange.test` | BioChange Admin |
| `medical@demo.biochange.test` | BioChange Medical |

Demo data is opt-in: it needs `SEED_DEMO=true` and a `DEMO_PASSWORD`, and it is refused for any non-local database unless `ALLOW_DEMO_IN_PRODUCTION=true`.

## OpenAI configuration

| Variable | Purpose | Default |
|---|---|---|
| `OPENAI_API_KEY` | Server-only key. Never exposed to the browser. | — |
| `OPENAI_MODEL` | Main agent model (Responses API) | `gpt-5.5` |
| `OPENAI_REASONING_EFFORT` | Optional: `none`/`minimal`/`low`/`medium`/`high` | unset |
| `OPENAI_EXTRACTION_MODEL` | Post-response extraction/classification | `gpt-5.4-mini` |
| `OPENAI_EMBEDDING_MODEL` | Embeddings (stored as 1536-dim vectors) | `text-embedding-3-small` |

Responses are sent with `store: false`. The application database is the canonical conversation archive.
Without a key, retrieval still works on keyword search, and the chat replies with a clear "not configured" message.
After you set the key, run `npm run kb:reindex` to add embeddings to the sources that are already approved.

## Admin bootstrap

```bash
ADMIN_EMAIL=you@biochange.life ADMIN_NAME="Your Name" ADMIN_PASSWORD='a-strong-passw0rd' npm run admin:bootstrap
# Medical reviewer:  ADMIN_ROLE=biochange_medical …
```

After that, under **Admin → Users & Clinics**, create clinics and invite veterinarians (no password needed: they receive an
invitation and sign in with an email link). The first staff sign-in enrols an authenticator app.

### Knowledge workflow (Admin → Knowledge Sources)

1. **Add source**: upload a PDF/TXT/MD file, or enter an approved URL (`KNOWLEDGE_FETCH_ALLOWED_HOSTS`).
2. The content is parsed (a PDF keeps its page numbers; an HTML page keeps its headings, and linked PDFs are offered as new sources).
3. Review the authority level, product, version, market and effective dates, plus the **extracted text** itself.
4. **Approve for agent**: the source is indexed into semantic chunks (procedure steps stay together, and warnings stay with the step they qualify) and embedded.
5. **Revoke** at any time. Uploading a new file creates a new version that supersedes the old one when it is approved.
6. Every source shows whether it is **used by the agent right now** and its index status (`indexed`, `keyword only`, `failed`, with the reason).
   A failed or keyword-only index can be retried with **Re-index**. **Delete permanently** removes the passages, the record and the stored file.
7. **Admin → Agent policy** sets the products in scope, allowed / disallowed topics, the out-of-scope reply and the BioChange escalation
   contact. It is versioned and added after the built-in rules (it can narrow them, never loosen them). It never exposes the system prompt or keys.

The critical-documents panel lists what is still missing (IFUs, regulatory documents, protocols, the claims matrix, training material, distributor information).
**Public website material alone is not sufficient for a production clinical agent.**
The demo sources tagged `demo-mock` are built only from public product-page text, so that the demo works. Revoke them in production.

---

## Demo deployment

A demo on Vercel (sample accounts and data, a visible demo banner, no outgoing email) is described step by step in
[`docs/DEMO_DEPLOY.md`](docs/DEMO_DEPLOY.md): `APP_ENV=staging` + `ALLOW_DEMO_IN_PRODUCTION=true`, Build Command
`npm run demo:setup && npm run build`. Demo data is refused when `APP_ENV=production`.

## Production deployment (Vercel + Supabase)

1. **Supabase**: create a project (choose an appropriate region, e.g. EU) and enable MFA on the account.
   - Database → Extensions: `vector` is available (the migration enables it).
   - Storage: create a **private** bucket called `private-files` (do **not** make it public).
   - Copy the database connection string. For serverless, use the transaction pooler (port 6543), which is supported.
2. Run migrations against Supabase: `DATABASE_URL=… npm run db:migrate`, then `npm run db:seed` (reference data only), then `admin:bootstrap`.
   - RLS is enabled on every table **with no policies**, and table privileges are revoked from `anon` and `authenticated`. Supabase's public REST API therefore exposes nothing. All access goes through the server.
3. **Supabase Auth** (identity verification only; the app keeps its own sessions and permissions):
   - Authentication → URL configuration: Site URL = `APP_URL`; add `APP_URL/auth/confirm` and `APP_URL/auth/callback` to the redirect allow-list.
   - Authentication → Email templates → **Magic link**: make the link point to the app's confirm page with the token hash:
     `<a href="{{ .RedirectTo }}?token_hash={{ .TokenHash }}&type=email">Sign in to BioChange</a>`
   - Optional Google: Authentication → Providers → Google (OAuth client from Google Cloud), then set `AUTH_GOOGLE_ENABLED=true`.
   - Configure custom SMTP for Supabase Auth emails and keep its rate limits.
4. **Vercel**: import the repo and set these environment variables (separately per environment, never shared between staging and production):
   `APP_ENV=production`, `APP_URL` (https), `DATABASE_URL`, `OPENAI_API_KEY`, `OPENAI_MODEL`, `STORAGE_DRIVER=supabase`, `SUPABASE_URL`,
   `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_STORAGE_BUCKET`, `AUTH_PROVIDER=supabase`, `AUTH_ENCRYPTION_KEY`,
   `EMAIL_DRIVER=resend`, `RESEND_API_KEY`, `EMAIL_FROM`, `CRON_SECRET`, and `FEATURES` (empty for the MVP).
   `vercel.json` schedules the daily reminder job (06:00 UTC).
   Never prefix a secret with `NEXT_PUBLIC_`. With `APP_ENV=staging|production` the app refuses to start with unsafe settings.
5. Enable MFA on the Vercel and Supabase accounts. Point uptime monitoring at `/api/health`.

## Tests

```bash
npm test          # needs a Postgres with pgvector; uses TEST_DATABASE_URL (default: …/biochange_test)
npm run typecheck
npm run build
```

`tests/acceptance.test.ts` automates the spec §38 loop end to end through `processMessage()` with a scripted model. Context building, tool execution, authorisation, persistence and auditing are all the real code.
`tests/safety.test.ts` covers knowledge governance (pending, revoked and authority ranking), knowledge-gap logging, citation filtering, safe fallbacks, clinic isolation through tools, and the role boundaries.
`tests/mvp.test.ts` covers the MVP hardening: untrusted text kept out of the developer message, audit/log redaction, feature flags,
sign-in links (invite-only, one-time, expiry, identity binding), sessions (idle timeout, MFA gating), TOTP (RFC 6238, replay),
knowledge index status and permanent deletion, the agent policy, structured feedback, upload validation (xlsx/macros/executables/size,
EXIF removal), file deletion, and the dashboard (staff-only, cross-clinic, filters, CSV export without patient references).

### Manual acceptance test (with a real OpenAI key)

Steps 4, 7 and 8 use inventory and ordering: run with `FEATURES=all`.

1. Sign in as `vet@demo.biochange.test`. The **Today** page shows the upcoming follow-up for case P-1042.
2. Ask: *"I have a 7mm pocket on 204 and I'm doing an open flap."* The answer cites `[S#]` chips, each with a View source link, and the agent offers to save the case.
3. Reply *"Yes, save it."* A case card appears with an *Open case* link.
4. Say *"I used one ReGum in that case."* Usage is recorded, and the agent reports the estimated stock (Inventory shows confirmed 4, estimated 2).
5. Say *"Schedule a recheck on <date>."* The follow-up appears on the case and on Today.
6. Start a **new conversation**: *"The 204 dog is back, PD 4 mm, healed well."* The agent finds the case and records the follow-up. The case page shows baseline 7 mm against follow-up 4 mm.
7. Record one more use. Today shows *ReGum Vet may be running low*.
8. Ask *"How many do I have left? Order the usual."* The agent answers with an estimate and prepares a **draft** for 2 packages. Click **Confirm & record order**.
9. Sign in as `admin@demo.biochange.test`. **Audit Log** shows every action, marked "from chat". **Analytics** and **Knowledge Gaps** are populated.
10. Ask something not covered (e.g. *"Can ReGum be combined with doxycycline gel?"*). The agent says it lacks approved information and offers escalation. Accept, then answer the request as `medical@demo.biochange.test` under **Escalations**. The vet sees the answer on Today.

## Scripts

| Script | Description |
|---|---|
| `db:migrate` / `db:reset` | Apply migrations / drop and recreate everything, then seed (dev only) |
| `db:seed` | Reference data (+ demo data when `SEED_DEMO=true` and `DEMO_PASSWORD` are set) |
| `admin:bootstrap` | Create or reset a BioChange admin |
| `kb:ingest-website` | Fetch and parse registered URL sources (they stay pending review) |
| `kb:import` | Load the approved files in `knowledge/` (see `knowledge/README.md`) as sources pending review |
| `kb:reindex` | Rebuild chunks and embeddings for approved sources |
| `demo:setup` | Migrate, seed the demo data (first run only) and index knowledge — used as the Vercel build step of a demo |
| `jobs:follow-ups` | Run the follow-up reminder job once (normally Vercel Cron runs it daily) |
| `eval:scope` | Check against the real model that unrelated requests are declined and BioChange questions answered |

## V1 limitations (by design)

No autonomous diagnosis or treatment decisions, no internet search during clinical answers, no automatic purchasing or distributor API, no image or radiograph interpretation, no messaging channels or voice.
The core is channel-independent (`processMessage(actor, channel, content)`), so messaging adapters can be added later without changing the agent.
