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

export type FileKind = "pdf" | "png" | "jpeg" | "webp" | "dicom" | "text" | "csv" | "xlsx";

const MIME_BY_KIND: Record<FileKind, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpeg: "image/jpeg",
  webp: "image/webp",
  dicom: "application/dicom",
  text: "text/plain",
  csv: "text/csv",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

const EXT_BY_KIND: Record<FileKind, string> = { pdf: "pdf", png: "png", jpeg: "jpg", webp: "webp", dicom: "dcm", text: "txt", csv: "csv", xlsx: "xlsx" };

export const IMAGE_KINDS: FileKind[] = ["png", "jpeg", "webp"];

/**
 * Identify a file by its content (magic bytes), not by its claimed name or MIME type.
 * The name is used only to tell CSV from plain text (both are UTF-8 text).
 * Spreadsheets: only macro-free .xlsx (Office Open XML) is accepted; .xls/.xlsm are refused.
 */
export function sniffKind(buf: Buffer, fileName?: string | null): FileKind | null {
  if (buf.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) return isPlainXlsx(buf) ? "xlsx" : null;
  if (buf.subarray(0, 5).toString("latin1") === "%PDF-") return "pdf";
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpeg";
  if (buf.subarray(0, 4).toString("latin1") === "RIFF" && buf.subarray(8, 12).toString("latin1") === "WEBP") return "webp";
  if (buf.length > 132 && buf.subarray(128, 132).toString("latin1") === "DICM") return "dicom";
  // Plain UTF-8 text without NUL bytes (used for .txt / .md knowledge uploads).
  const head = buf.subarray(0, Math.min(buf.length, 4096));
  if (!head.includes(0)) {
    try {
      // stream:true tolerates a multibyte character cut at the 4 KB boundary.
      new TextDecoder("utf-8", { fatal: true }).decode(head, { stream: buf.length > head.length });
      return /\.csv$/i.test(fileName ?? "") ? "csv" : "text";
    } catch {
      return null;
    }
  }
  return null;
}

/** Entry names from a zip's central directory, or null if the archive structure is invalid. */
export function zipEntryNames(buf: Buffer): string[] | null {
  // End of central directory: last 22..(22+65535) bytes.
  const min = Math.max(0, buf.length - 22 - 0xffff);
  let eocd = -1;
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const names: string[] = [];
  for (let n = 0; n < count; n++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== 0x02014b50) return null;
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    if (off + 46 + nameLen > buf.length) return null;
    names.push(buf.subarray(off + 46, off + 46 + nameLen).toString("utf8"));
    off += 46 + nameLen + extraLen + commentLen;
  }
  return names;
}

/** Office Open XML workbook without VBA/macros, embedded objects or external binaries. */
function isPlainXlsx(buf: Buffer): boolean {
  const names = zipEntryNames(buf);
  if (!names || !names.includes("[Content_Types].xml") || !names.includes("xl/workbook.xml")) return false;
  if (names.some((n) => n.includes("..") || n.startsWith("/"))) return false;
  if (names.some((n) => /vbaProject\.bin$|^xl\/embeddings\/|^xl\/activeX\/|\.(exe|dll|js|vbs|bat|cmd|ps1|sh)$/i.test(n))) return false;
  return true;
}

/**
 * Re-encodes an image: drops EXIF/XMP/GPS and other metadata (which can reveal location or
 * device and owner details) and neutralises polyglot files. EXIF orientation is applied first.
 */
export async function sanitizeImage(buf: Buffer, kind: FileKind): Promise<Buffer> {
  const sharp = (await import("sharp")).default;
  try {
    const img = sharp(buf, { limitInputPixels: 80_000_000, failOn: "error" }).rotate();
    if (kind === "png") return await img.png().toBuffer();
    if (kind === "webp") return await img.webp({ quality: 92 }).toBuffer();
    return await img.jpeg({ quality: 92, mozjpeg: true }).toBuffer();
  } catch {
    throw new ValidationError("The image could not be processed. Please upload a valid JPEG, PNG or WebP file.");
  }
}

export function isImageKind(kind: string): boolean {
  return IMAGE_KINDS.includes(kind as FileKind);
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

export async function putFile(
  prefix: "cases" | "knowledge",
  input: Buffer,
  allowed: FileKind[],
  maxBytes: number,
  opts: { fileName?: string | null; sanitizeImages?: boolean } = {},
): Promise<StoredFile> {
  if (input.length === 0) throw new ValidationError("The file is empty.");
  if (input.length > maxBytes) throw new ValidationError(`File is too large (max ${Math.round(maxBytes / 1024 / 1024)} MB).`);
  const kind = sniffKind(input, opts.fileName);
  if (!kind || !allowed.includes(kind)) {
    throw new ValidationError(`Unsupported file type. Allowed: ${allowed.join(", ")}.`);
  }
  const buf = opts.sanitizeImages && isImageKind(kind) ? await sanitizeImage(input, kind) : input;
  // Random internal name: the uploaded file name is never used as a path.
  const storagePath = `${prefix}/${new Date().toISOString().slice(0, 7)}/${crypto.randomUUID()}.${EXT_BY_KIND[kind]}`;
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

/** Removes a stored object (used when a file or knowledge source is deleted). Missing objects are not an error. */
export async function deleteFile(storagePath: string): Promise<void> {
  const e = env();
  if (e.STORAGE_DRIVER === "supabase") {
    const res = await fetch(`${supabaseBase()}/object/${e.SUPABASE_STORAGE_BUCKET}`, {
      method: "DELETE",
      headers: { ...supabaseHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ prefixes: [storagePath] }),
    });
    if (!res.ok && res.status !== 404) throw new Error(`Storage delete failed (${res.status})`);
    return;
  }
  await fs.rm(localPath(storagePath), { force: true });
}

/**
 * Short-lived signed URL (Supabase) or null for the local driver (caller streams instead).
 * `downloadAs` makes the storage server send it as an attachment instead of rendering it.
 */
export async function signedUrl(storagePath: string, expiresInSeconds = 120, downloadAs?: string): Promise<string | null> {
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
  const url = `${supabaseBase()}${body.signedURL}`;
  return downloadAs ? `${url}${url.includes("?") ? "&" : "?"}download=${encodeURIComponent(downloadAs)}` : url;
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
