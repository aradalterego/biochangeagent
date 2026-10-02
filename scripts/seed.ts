/**
 * Seeds reference data (products, knowledge source registry, education resources) and,
 * unless disabled, a demo clinic with demo accounts, a demo case, inventory and orders.
 *
 *   npm run db:seed                 # reference + demo data (refused in production)
 *   SEED_DEMO=false npm run db:seed # reference data only
 */
import "dotenv/config";
import { sql, closeDb } from "@/lib/db";
import { hashPassword } from "@/lib/auth/password";
import { indexSource } from "@/server/knowledge/sources";
import { recomputeAdoption } from "@/server/domain/adoption";

const DEMO = process.env.SEED_DEMO !== "false";
const DEMO_PASSWORD = process.env.DEMO_PASSWORD || "DemoVet2026!";
const days = (n: number) => new Date(Date.now() + n * 864e5);
const dateStr = (d: Date) => d.toISOString().slice(0, 10);

async function main() {
  if (DEMO && process.env.NODE_ENV === "production" && process.env.ALLOW_DEMO_IN_PRODUCTION !== "true") {
    throw new Error("Refusing to seed demo accounts in production. Set SEED_DEMO=false (or ALLOW_DEMO_IN_PRODUCTION=true for a staging environment).");
  }
  const [{ n }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM products`;
  if (n > 0 && !process.argv.includes("--force")) {
    console.log("Database already seeded (products exist). Use `npm run db:reset` for a clean demo database.");
    return;
  }

  // ------------------------------------------------------------------ distributor & products
  const [distributor] = await sql<{ id: string }[]>`
    INSERT INTO distributors (name, country, ordering_notes)
    VALUES ('PRN — authorised distributor (PLACEHOLDER)', 'US',
            'Placeholder record. Replace with the approved PRN / authorised distributor contact, ordering channel, SKUs and package quantities.')
    RETURNING id`;

  const [regum] = await sql<{ id: string }[]>`
    INSERT INTO products (name, product_family, variant, sku, form, units_per_package, market, description, is_placeholder_sku)
    VALUES ('ReGum Vet', 'ReGum Vet', NULL, 'REGUM-VET-TBD', 'Foam scaffold', 1, 'global',
            'Veterinary regenerative periodontal product based on BioChange scaffold technology. Used in approved periodontal/surgical contexts according to current approved BioChange documentation.',
            true) RETURNING id`;
  const [microfoam] = await sql<{ id: string }[]>`
    INSERT INTO products (name, product_family, variant, sku, form, units_per_package, market, description, is_placeholder_sku)
    VALUES ('MicroFoam', 'MicroFoam', NULL, 'MICROFOAM-TBD', 'Mini foam scaffold', 1, 'global',
            'Veterinary periodontal product intended for approved early/non-surgical periodontal contexts according to current BioChange documentation.',
            true) RETURNING id`;

  // ------------------------------------------------------------------ knowledge source registry
  // Placeholders: critical internal documents that must be uploaded and approved manually.
  const placeholders: [string, string, string | null, number, string][] = [
    ["ReGum Vet — Instructions for Use (current approved IFU)", "ifu", "ReGum Vet", 1, "Upload the latest approved IFU PDF."],
    ["MicroFoam — Instructions for Use (current approved IFU)", "ifu", "MicroFoam", 1, "Upload the latest approved IFU PDF."],
    ["Regulatory status documentation (per market)", "regulatory", null, 1, "Registration / clearance status per market."],
    ["ReGum Vet — clinical guidelines / protocol", "clinical_protocol", "ReGum Vet", 2, "Approved case selection and procedure protocol."],
    ["MicroFoam — clinical guidelines / protocol", "clinical_protocol", "MicroFoam", 2, "Approved case selection and procedure protocol."],
    ["Approved claims matrix", "internal_approved_document", null, 2, "Approved claim wording per product and market."],
    ["Internal medical answers (approved)", "internal_approved_document", null, 2, "Approved answers from BioChange Medical."],
    ["ReGum / MicroFoam training deck", "training_material", null, 4, "Approved training slides."],
    ["BioChange product FAQs (approved)", "faq", null, 4, "Approved FAQ document."],
    ["Pricing information", "commercial_information", null, 7, "Current price list per market / distributor."],
    ["PRN / authorised distributor — ordering information, SKUs, package quantities", "distributor_material", null, 6, "Approved distributor ordering details."],
    ["BioChange sales documents", "commercial_information", null, 7, "Approved sales material."],
  ];
  for (const [title, type, product, level, notes] of placeholders) {
    await sql`INSERT INTO knowledge_sources (title, source_type, product, authority_level, parse_status, is_placeholder, notes, tags)
              VALUES (${title}, ${type}, ${product}, ${level}, 'placeholder', true, ${`PLACEHOLDER — ${notes}`}, ${["placeholder"]})`;
  }

  // Public website references (fetched by `npm run kb:ingest-website`, then reviewed by an admin).
  const web: [string, string, string | null, string, number, string[]][] = [
    ["BioChange — main website", "https://biochange.life/", null, "product_page", 7, ["website"]],
    ["ReGum Vet — product page", "https://biochange.life/regum-vet/", "ReGum Vet", "product_page", 7, ["website", "faq"]],
    ["MicroFoam — product page", "https://biochange.life/microfoam/", "MicroFoam", "product_page", 7, ["website"]],
    ["BioChange Veterinary Educational Center", "https://biochange.life/educational/", null, "training_material", 4, ["website", "education"]],
    ["BioChange — posters and publications", "https://biochange.life/publications/", null, "product_page", 7, ["website", "publications"]],
  ];
  for (const [title, url, product, type, level, tags] of web) {
    await sql`INSERT INTO knowledge_sources (title, source_url, product, source_type, authority_level, clinical_or_commercial, tags, notes)
              VALUES (${title}, ${url}, ${product}, ${type}, ${level}, 'both', ${tags},
                      'Public website material. Not sufficient on its own for clinical guidance.')`;
  }

  // Peer-reviewed evidence, with structured study metadata.
  const [study] = await sql<{ id: string }[]>`
    INSERT INTO knowledge_sources (title, source_type, product, authority_level, source_url, publication_date, version, clinical_or_commercial, tags, notes)
    VALUES ('Gawor JP, Strøm P, Nemec A. Treatment of Naturally Occurring Periodontitis in Dogs With a New Bio-Absorbable Regenerative Matrix. Front Vet Sci 2022;9:916171',
            'peer_reviewed_research', 'ReGum Vet', 3,
            'https://biochange.life/wp-content/uploads/2026/02/ReGum-Vet-Canine-Clinical-study-2022.pdf', '2022-06-21', 'doi:10.3389/fvets.2022.916171',
            'clinical', ${["study", "regum", "periodontitis"]}, 'Open-access (CC BY). Funded by BioChange Ltd.')
    RETURNING id`;
  await sql`
    INSERT INTO evidence_studies (source_id, publication, authors, journal, year, study_design, sample_size, intervention, control, outcomes, limitations, funding_conflicts, key_approved_claims)
    VALUES (${study.id}, 'Treatment of Naturally Occurring Periodontitis in Dogs With a New Bio-Absorbable Regenerative Matrix',
      'Gawor JP, Strøm P, Nemec A', 'Frontiers in Veterinary Science (Brief Research Report)', 2022,
      'Multicenter, prospective interventional clinical study; split-mouth design (side allocated by coin toss); recheck under general anaesthesia at 3 months (T90).',
      '9 client-owned dogs, 22 teeth (PD analysed for 11 tooth pairs; CBCT bone measurements for 9 pairs).',
      'Open periodontal therapy + gelatin (porcine, transglutaminase cross-linked) porous scaffold implant (ReGum).',
      'Open periodontal therapy alone (contralateral teeth).',
      'At 3 months, probing depth reduced on average 2.0 mm (implant) vs 1.0 mm (control), statistically significant; alveolar bone height gain 1.26 mm palatally / 1.51 mm buccally (implant) vs 0.58 / 0.7 mm (control), significant for the buccal site. All procedures uneventful; flaps healed.',
      'Small sample (9 dogs); short follow-up (3 months); no histology, so regeneration vs enhanced repair cannot be distinguished; no untreated baseline control; mostly maxillary multi-rooted teeth (20 of 22 maxillary).',
      'Funded by BioChange Ltd; the funder was involved in material design and development and in the decision to submit for publication.',
      ${[]})`;

  // ------------------------------------------------------------------ education resources
  const edu: [string, string, string | null, string | null, string, string, boolean][] = [
    ["BioChange Veterinary Educational Center", "product_education", null, "https://biochange.life/educational/", "intro", "Tutorials, case studies, technical content and testimonials.", false],
    ["ReGum Vet — product overview", "product_education", "ReGum Vet", "https://biochange.life/regum-vet/", "intro", "Public product page with application overview and FAQ.", false],
    ["MicroFoam — product overview", "product_education", "MicroFoam", "https://biochange.life/microfoam/", "intro", "Public product page.", false],
    ["ReGum Vet canine clinical study (Gawor et al., 2022)", "study", "ReGum Vet", "https://biochange.life/wp-content/uploads/2026/02/ReGum-Vet-Canine-Clinical-study-2022.pdf", "advanced", "Split-mouth clinical study in 9 dogs.", false],
    ["BioChange webinars & tutorials (YouTube)", "webinar", null, "https://www.youtube.com/@BioChange", "intermediate", "Recorded webinars and tutorials.", false],
    ["ReGum Vet introductory training (placeholder — link the approved course)", "training_course", "ReGum Vet", null, "intro", "Completing this marks ReGum training as completed.", true],
    ["MicroFoam introductory training (placeholder — link the approved course)", "training_course", "MicroFoam", null, "intro", "Completing this marks MicroFoam training as completed.", true],
  ];
  for (const [title, type, product, url, level, desc, training] of edu) {
    await sql`INSERT INTO education_resources (title, resource_type, product, url, level, description, counts_as_training, source_id)
              VALUES (${title}, ${type}, ${product}, ${url}, ${level}, ${desc}, ${training}, ${type === "study" ? study.id : null})`;
  }

  // Draft claims for medical/regulatory review — none are approved automatically.
  await sql`INSERT INTO approved_claims (claim, product, claim_type, source_id, allowed_context, status) VALUES
    ('In a split-mouth study of 9 dogs, adding ReGum to open periodontal therapy gave significantly greater probing depth reduction at 3 months than open periodontal therapy alone (2.0 vs 1.0 mm on average).',
     'ReGum Vet', 'clinical_evidence', ${study.id}, 'Evidence discussions; always with study size and follow-up length.', 'draft')`;

  console.log("Reference data seeded.");
  if (!DEMO) return;

  // ------------------------------------------------------------------ DEMO data
  const [clinic] = await sql<{ id: string }[]>`
    INSERT INTO clinics (name, country, timezone, distributor_id, estimated_dental_cases_per_month)
    VALUES ('Demo Veterinary Dental Clinic', 'US', 'America/New_York', ${distributor.id}, 12) RETURNING id`;
  const hash = await hashPassword(DEMO_PASSWORD);
  const mk = async (email: string, name: string, role: string, clinicId: string | null, title: string | null) => {
    const [u] = await sql<{ id: string }[]>`
      INSERT INTO users (email, name, role, clinic_id, professional_title, country, timezone, password_hash)
      VALUES (${email}, ${name}, ${role}, ${clinicId}, ${title}, 'US', 'America/New_York', ${hash}) RETURNING id`;
    return u.id;
  };
  const vet = await mk("vet@demo.biochange.test", "Dr. Dana Levi", "veterinarian", clinic.id, "DVM");
  await mk("clinic-admin@demo.biochange.test", "Sam Cohen", "clinic_admin", clinic.id, "Practice manager");
  await mk("admin@demo.biochange.test", "BioChange Admin (demo)", "biochange_admin", null, null);
  await mk("medical@demo.biochange.test", "BioChange Medical (demo)", "biochange_medical", null, "DVM");

  await sql`INSERT INTO veterinarian_profiles (user_id, specialty, years_in_practice, dental_experience_level, regenerative_dentistry_experience,
              regum_training_status, microfoam_training_status, preferred_answer_depth)
            VALUES (${vet}, 'General practice with dental focus', 9, 'intermediate', 'some', 'completed', 'not_started', 'concise')`;

  // Demo-only knowledge built strictly from BioChange's public website text, clearly labelled.
  const demoSources: [string, string, string][] = [
    [
      "DEMO MOCK — ReGum Vet product information (from public website text; replace with the approved IFU)",
      "ReGum Vet",
      `# ReGum Vet — overview
ReGum™ Vet is a foam scaffold designed to support periodontal tissue repair surgical procedures in dogs. It is intended for surgical procedures in advanced periodontitis.

# Application — 4 steps (as published on the product page)
1. Wet ReGum Vet to reconstitute elasticity.
2. Trim ReGum Vet to fit the surgical site.
3. After debridement, place ReGum Vet in the surgical site.
4. Close the surgical site.

# What ReGum Vet supports
- Filling and stabilizing periodontal defects
- Bone and soft tissue repair
- It is gradually resorbed and replaced by new tissue during healing

# Listed uses on the product page
- Socket preservation
- Bone and furcation restoration
- Mandibular fracture healing
- Periodontal pockets and alveolar augmentation after extraction

# Post-operative care (FAQ)
No special care is required beyond standard post-dental procedure instructions. The scaffold is biodegradable and does not require removal. Anaesthesia is standard care for periodontal procedures.`,
    ],
    [
      "DEMO MOCK — MicroFoam product information (from public website text; replace with the approved IFU)",
      "MicroFoam",
      `# MicroFoam — overview
MicroFoam™ is a mini-size foam scaffold based on CellFoam™ technology, for the filling and augmentation of periodontal pockets in a non-surgical procedure, following closed root planing, in dogs. It is positioned for early-stage periodontitis.

# Application — 1 step (as published on the product page)
Place MicroFoam into the pocket site 1 mm below the gumline, and apply gentle pressure for a few seconds.`,
    ],
  ];
  for (const [title, product, text] of demoSources) {
    const [s] = await sql<{ id: string }[]>`
      INSERT INTO knowledge_sources (title, source_type, product, authority_level, source_url, version, status, extracted_text, parse_status,
        tags, notes, last_reviewed_at, effective_from)
      VALUES (${title}, 'ifu', ${product}, 1, 'https://biochange.life/', 'demo-1', 'approved', ${text}, 'parsed', ${["demo-mock"]},
        'DEMO ONLY. Content copied from the public product page so the demo loop works. It is NOT the IFU and must be revoked in production.',
        now(), current_date - 30)
      RETURNING id`;
    const r = await indexSource(s.id);
    console.log(`Indexed demo source "${product}": ${r.chunks} chunks${r.embedded ? " (with embeddings)" : " (keyword only — no OPENAI_API_KEY)"}`);
  }

  // Inventory, orders, usage and a treated case with a follow-up coming up.
  await sql`INSERT INTO orders (clinic_id, product_id, quantity, order_date, status, distributor_id, created_by, confirmed_by, created_at)
            VALUES (${clinic.id}, ${regum.id}, 2, ${dateStr(days(-75))}, 'received', ${distributor.id}, ${vet}, ${vet}, ${days(-75)})`;
  await sql`INSERT INTO inventory (clinic_id, product_id, quantity_confirmed, last_confirmed_at, last_confirmed_by, quantity_estimated)
            VALUES (${clinic.id}, ${regum.id}, 4, ${days(-40)}, ${vet}, 4),
                   (${clinic.id}, ${microfoam.id}, NULL, NULL, NULL, NULL)`;
  await sql`INSERT INTO inventory_events (clinic_id, product_id, event_type, quantity, estimated_after, created_by, created_at)
            VALUES (${clinic.id}, ${regum.id}, 'confirmed_count', 4, 4, ${vet}, ${days(-40)})`;

  const [c1] = await sql<{ id: string }[]>`
    INSERT INTO cases (clinic_id, created_by, internal_patient_identifier, species, breed, age, tooth, condition_summary, pocket_depth_mm,
      defect_type, furcation, procedure_type, treatment_goal, product_id, treatment_date, status, baseline_notes, follow_up_date, created_at)
    VALUES (${clinic.id}, ${vet}, 'P-1042', 'dog', 'Labrador Retriever', '8y', '108', 'Periodontitis, vertical bone loss distal root', 6,
      'Infrabony, 2-wall', 'F1', 'Open flap periodontal surgery', 'Preserve tooth', ${regum.id}, ${dateStr(days(-25))}, 'treated',
      'Baseline radiograph taken. Moderate gingival bleeding.', ${dateStr(days(3))}, ${days(-25)})
    RETURNING id`;
  await sql`INSERT INTO case_measurements (case_id, kind, measured_at, tooth, pocket_depth_mm, furcation, notes, recorded_by)
            VALUES (${c1.id}, 'baseline', ${dateStr(days(-25))}, '108', 6, 'F1', 'Baseline probing', ${vet})`;
  await sql`INSERT INTO follow_ups (case_id, due_at, reason, created_by) VALUES (${c1.id}, ${dateStr(days(3))}, 'Post-treatment recheck', ${vet})`;
  await sql`INSERT INTO inventory_events (clinic_id, product_id, event_type, quantity, estimated_after, case_id, created_by, created_at)
            VALUES (${clinic.id}, ${regum.id}, 'usage', 1, 3, ${c1.id}, ${vet}, ${days(-25)})`;
  await sql`UPDATE inventory SET quantity_estimated = 3 WHERE clinic_id = ${clinic.id} AND product_id = ${regum.id}`;

  await sql`INSERT INTO memories (user_id, clinic_id, memory_type, content, confidence, source) VALUES
    (${vet}, ${clinic.id}, 'preference', 'Prefers concise step-by-step answers during procedures.', 0.9, 'seed'),
    (${vet}, ${clinic.id}, 'ordering', 'The clinic usually orders two packages of ReGum Vet at a time.', 0.85, 'seed'),
    (${vet}, ${clinic.id}, 'training', 'Completed ReGum Vet introductory training.', 0.95, 'seed')`;

  await recomputeAdoption(vet);

  console.log(`
Demo data seeded. Demo accounts (password: ${DEMO_PASSWORD}):
  vet@demo.biochange.test           Veterinarian
  clinic-admin@demo.biochange.test  Clinic Admin
  admin@demo.biochange.test         BioChange Admin
  medical@demo.biochange.test       BioChange Medical
`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
