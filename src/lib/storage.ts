import "server-only";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { env } from "./env";
import { ValidationError } from "./authz";

/**
 * Private file storage. Files are never publicly addressable: they are served only through
 * authenticated route handlers that check permissions first, which then stream the file
 * (local driver) or redirect to a short-lived signed URL (Supabase driver).
 */

export type FileKind = "pdf" | "png" | "jpeg" | "webp" | "dicom" | "text";

const MIME_BY_KIND: Record<FileKind, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpeg: "image/jpeg",
  webp: "image/webp",
  dicom: "application/dicom",
  text: "text/plain",
};

/** Identify a file by its content (magic bytes), not by its claimed name or MIME type. */
export function sniffKind(buf: Buffer): FileKind | null {
  if (buf.subarray(0, 5).toString("latin1") === "%PDF-") return "pdf";
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpeg";
  if (buf.subarray(0, 4).toString("latin1") === "RIFF" && buf.subarray(8, 12).toString("latin1") === "WEBP") return "webp";
  if (buf.length > 132 && buf.subarray(128, 132).toString("latin1") === "DICM") return "dicom";
  // Plain UTF-8 text without NUL bytes (used for .txt / .md knowledge uploads).
  const head = buf.subarray(0, Math.min(buf.length, 4096));
  if (!head.includes(0) && Buffer.from(head.toString("utf8"), "utf8").equals(head)) return "text";
  return null;
}

export function mimeFor(kind: FileKind): string {
  return MIME_BY_KIND[kind];
}

export function sanitizeFileName(name: string): string {
  const base = path.basename(name).normalize("NFKC").replace(/[^\w.\- ]+/g, "_").trim();
  return (base || "file").slice(0, 120);
}

export interface StoredFile {
  storagePath: string;
  kind: FileKind;
  mimeType: string;
  size: number;
  sha256: string;
}

export async function putFile(prefix: "cases" | "knowledge", buf: Buffer, allowed: FileKind[], maxBytes: number): Promise<StoredFile> {
  if (buf.length === 0) throw new ValidationError("The file is empty.");
  if (buf.length > maxBytes) throw new ValidationError(`File is too large (max ${Math.round(maxBytes / 1024 / 1024)} MB).`);
  const kind = sniffKind(buf);
  if (!kind || !allowed.includes(kind)) {
    throw new ValidationError(`Unsupported file type. Allowed: ${allowed.join(", ")}.`);
  }
  const ext = kind === "jpeg" ? "jpg" : kind === "text" ? "txt" : kind === "dicom" ? "dcm" : kind;
  const storagePath = `${prefix}/${new Date().toISOString().slice(0, 7)}/${crypto.randomUUID()}.${ext}`;
  const e = env();
  if (e.STORAGE_DRIVER === "supabase") {
    const res = await fetch(`${supabaseBase()}/object/${e.SUPABASE_STORAGE_BUCKET}/${storagePath}`, {
      method: "POST",
      headers: { ...supabaseHeaders(), "Content-Type": mimeFor(kind), "x-upsert": "false" },
      body: new Uint8Array(buf),
    });
    if (!res.ok) throw new Error(`Storage upload failed (${res.status})`);
  } else {
    const full = localPath(storagePath);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, buf, { mode: 0o600 });
  }
  return {
    storagePath,
    kind,
    mimeType: mimeFor(kind),
    size: buf.length,
    sha256: crypto.createHash("sha256").update(buf).digest("hex"),
  };
}

export async function readFile(storagePath: string): Promise<Buffer> {
  const e = env();
  if (e.STORAGE_DRIVER === "supabase") {
    const res = await fetch(`${supabaseBase()}/object/${e.SUPABASE_STORAGE_BUCKET}/${storagePath}`, { headers: supabaseHeaders() });
    if (!res.ok) throw new Error(`Storage download failed (${res.status})`);
    return Buffer.from(await res.arrayBuffer());
  }
  return fs.readFile(localPath(storagePath));
}

/** Short-lived signed URL (Supabase) or null for the local driver (caller streams instead). */
export async function signedUrl(storagePath: string, expiresInSeconds = 120): Promise<string | null> {
  const e = env();
  if (e.STORAGE_DRIVER !== "supabase") return null;
  const res = await fetch(`${supabaseBase()}/object/sign/${e.SUPABASE_STORAGE_BUCKET}/${storagePath}`, {
    method: "POST",
    headers: { ...supabaseHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ expiresIn: expiresInSeconds }),
  });
  if (!res.ok) throw new Error(`Could not sign storage URL (${res.status})`);
  const body = (await res.json()) as { signedURL?: string };
  if (!body.signedURL) throw new Error("Storage did not return a signed URL");
  return `${supabaseBase()}${body.signedURL}`;
}

function localPath(storagePath: string): string {
  const root = path.resolve(env().LOCAL_STORAGE_DIR);
  const full = path.resolve(root, storagePath);
  if (!full.startsWith(root + path.sep)) throw new ValidationError("Invalid storage path");
  return full;
}

function supabaseBase(): string {
  const url = env().SUPABASE_URL;
  if (!url) throw new Error("SUPABASE_URL is required when STORAGE_DRIVER=supabase");
  return `${url.replace(/\/$/, "")}/storage/v1`;
}

function supabaseHeaders(): Record<string, string> {
  const key = env().SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error("SUPABASE_SERVICE_ROLE_KEY is required when STORAGE_DRIVER=supabase");
  return { Authorization: `Bearer ${key}`, apikey: key };
}
