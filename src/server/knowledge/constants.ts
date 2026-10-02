export const SOURCE_TYPES = [
  "ifu",
  "regulatory",
  "clinical_protocol",
  "internal_approved_document",
  "peer_reviewed_research",
  "training_material",
  "case_study",
  "faq",
  "distributor_material",
  "product_page",
  "commercial_information",
] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

export const SOURCE_TYPE_LABELS: Record<SourceType, string> = {
  ifu: "IFU",
  regulatory: "Regulatory",
  product_page: "BioChange Product Page",
  training_material: "BioChange Training Material",
  peer_reviewed_research: "Peer Reviewed Research",
  clinical_protocol: "Clinical Protocol",
  case_study: "Case Study",
  faq: "FAQ",
  distributor_material: "Distributor Material",
  commercial_information: "Commercial Information",
  internal_approved_document: "Internal Approved Document",
};

/**
 * Source authority hierarchy (1 = most authoritative). The admin confirms the level when
 * reviewing; these are the defaults proposed for each source type.
 */
export const AUTHORITY_LEVELS: Record<number, string> = {
  1: "Current approved IFU / regulatory documentation",
  2: "BioChange approved clinical protocols & internal medical knowledge",
  3: "Peer-reviewed scientific publications",
  4: "BioChange approved training material",
  5: "BioChange approved clinical case studies",
  6: "Approved distributor material",
  7: "Commercial & marketing material",
};

export const DEFAULT_AUTHORITY: Record<SourceType, number> = {
  ifu: 1,
  regulatory: 1,
  clinical_protocol: 2,
  internal_approved_document: 2,
  peer_reviewed_research: 3,
  training_material: 4,
  faq: 4,
  case_study: 5,
  distributor_material: 6,
  product_page: 7,
  commercial_information: 7,
};

export const PRODUCT_FAMILIES = ["ReGum Vet", "MicroFoam"] as const;

/**
 * Documents a production clinical agent needs. The admin dashboard shows which of these
 * have no approved, non-placeholder source yet. Public website material alone is not enough.
 */
export const CRITICAL_DOCUMENTS: { key: string; title: string; product: string | null; sourceTypes: SourceType[] }[] = [
  { key: "regum-ifu", title: "ReGum Vet — current approved IFU", product: "ReGum Vet", sourceTypes: ["ifu"] },
  { key: "microfoam-ifu", title: "MicroFoam — current approved IFU", product: "MicroFoam", sourceTypes: ["ifu"] },
  { key: "regulatory", title: "Regulatory status documentation (per market)", product: null, sourceTypes: ["regulatory"] },
  { key: "regum-protocol", title: "ReGum Vet — approved clinical protocol / guidelines", product: "ReGum Vet", sourceTypes: ["clinical_protocol"] },
  { key: "microfoam-protocol", title: "MicroFoam — approved clinical protocol / guidelines", product: "MicroFoam", sourceTypes: ["clinical_protocol"] },
  { key: "claims-matrix", title: "Approved claims matrix", product: null, sourceTypes: ["internal_approved_document"] },
  { key: "regum-evidence", title: "ReGum Vet — peer-reviewed evidence", product: "ReGum Vet", sourceTypes: ["peer_reviewed_research"] },
  { key: "training", title: "Approved training material", product: null, sourceTypes: ["training_material"] },
  { key: "distributor", title: "Authorised distributor / ordering information (SKUs, package sizes)", product: null, sourceTypes: ["distributor_material", "commercial_information"] },
];

export const CLAIM_TYPES = ["mechanism", "indication", "handling", "biocompatibility", "biodegradation", "clinical_evidence", "commercial", "safety", "other"] as const;
