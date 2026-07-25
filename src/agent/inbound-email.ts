/**
 * Inbound email parsing (pure).
 *
 * `POST /api/inbound` is the endpoint an email provider (SendGrid Inbound
 * Parse, Mailgun Routes, Postmark) or a plain contact form posts to. Each of
 * those speaks a slightly different dialect, so ALL of the parsing lives here,
 * in one pure, dependency-free module that the route simply calls:
 *
 *  (a) JSON `{ from, subject, text }` / `{ from, subject, body }` — provider or
 *      contact-form style. `from` may be `"Name <a@b.com>"` or a bare address.
 *  (b) JSON already shaped as `{ rawEmail: RawEmailRecord }`, or a bare
 *      `RawEmailRecord` (`fromName` / `fromEmail` / `subject` / `body`).
 *  (c) `application/x-www-form-urlencoded` — SendGrid posts form-encoded, with
 *      the same field names as (a).
 *  (d) `text/plain` raw RFC822 — `From:` / `Subject:` headers, then a blank
 *      line, then the body.
 *
 * Three rules hold for every shape:
 *  - NEVER THROWS. Malformed JSON, an empty body, a binary blob — all return
 *    `null`. The route turns `null` into a 400 with a clear message.
 *  - NEVER INVENTS. A field that is not present in the payload is not guessed.
 *    A missing sender name becomes `""`, which `normalizeLead` maps to the
 *    `"unknown"` marker; it is never back-derived from the email address.
 *  - LOSSLESS. Every provider field that is not one of the recognized
 *    sender/subject/body keys is preserved verbatim in `formFields`, so the
 *    audit trail keeps whatever the provider sent (`to`, `envelope`,
 *    `spam_score`, custom contact-form questions, …).
 */

import type { IsoTimestamp, RawEmailRecord } from "./contracts";

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export interface InboundEmailInput {
  /** The request's `Content-Type` header, or `null` when absent. */
  contentType: string | null;
  /** The raw request body, exactly as received. */
  rawBody: string;
}

/** The wire dialect a payload was recognized as. Exported for tests/diagnostics. */
export type InboundPayloadKind = "json" | "form" | "rfc822";

// ---------------------------------------------------------------------------
// Recognized field names (compared lowercased, with `_`/`-` stripped)
// ---------------------------------------------------------------------------

/** Keys that carry a combined sender, e.g. `"Ana Ruiz <ana@acme.io>"`. */
const COMBINED_SENDER_KEYS = ["from", "sender", "fromaddress", "replyto"];
/** Keys that carry a bare email address. */
const EMAIL_KEYS = ["fromemail", "senderemail", "email", "fromaddr"];
/** Keys that carry a display name only. */
const NAME_KEYS = ["fromname", "sendername", "name"];
/** Keys that carry the subject line. */
const SUBJECT_KEYS = ["subject"];
/** Keys that carry the plain-text body, in preference order. */
const BODY_KEYS = ["body", "text", "plain", "textbody", "message", "bodyplain"];
/** Keys that carry an HTML body, used only when no plain-text body exists. */
const HTML_KEYS = ["html", "htmlbody", "bodyhtml"];
/** Keys that carry a receipt timestamp. */
const RECEIVED_AT_KEYS = ["receivedat", "date", "timestamp", "sentat"];

/** Normalizes a field name for comparison: lowercase, no separators. */
function canonicalKey(key: string): string {
  return key.toLowerCase().replace(/[\s_-]/g, "");
}

function isBlank(value: string | undefined): value is undefined {
  return value === undefined || value.trim() === "";
}

function collapse(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

// ---------------------------------------------------------------------------
// Sender parsing — `"Name <a@b.com>"` or a bare address
// ---------------------------------------------------------------------------

const EMAIL_PATTERN = /[^\s<>@,;:"]+@[^\s<>@,;:"]+\.[^\s<>@,;:"]+/;

export interface ParsedSender {
  name: string;
  email: string;
}

/**
 * Splits a sender string into a display name and an address.
 *
 * Handles `Name <a@b.com>`, `"Name" <a@b.com>`, `<a@b.com>` and a bare
 * `a@b.com`. Returns `null` when the string holds no address at all — the
 * address is what the pipeline needs, and it is never fabricated from the name.
 */
export function parseSender(raw: string): ParsedSender | null {
  const value = collapse(raw);
  if (value === "") return null;

  const angle = /^(.*)<\s*([^>]+)\s*>\s*$/.exec(value);
  if (angle !== null) {
    const namePart = collapse(angle[1] ?? "").replace(/^"(.*)"$/, "$1").trim();
    const addressPart = collapse(angle[2] ?? "");
    const address = EMAIL_PATTERN.exec(addressPart);
    if (address === null) return null;
    return { name: namePart, email: address[0].toLowerCase() };
  }

  const bare = EMAIL_PATTERN.exec(value);
  if (bare === null) return null;
  // A bare address carries no display name; we do NOT derive one from the
  // local part, because that would be an invention.
  const remainder = collapse(value.replace(bare[0], ""));
  return { name: remainder === "" ? "" : remainder, email: bare[0].toLowerCase() };
}

// ---------------------------------------------------------------------------
// Dialect detection and field extraction
// ---------------------------------------------------------------------------

/** Chooses the dialect from the content type, falling back to body sniffing. */
function detectKind(contentType: string | null, rawBody: string): InboundPayloadKind {
  const type = (contentType ?? "").toLowerCase();
  if (type.includes("json")) return "json";
  if (type.includes("x-www-form-urlencoded")) return "form";
  if (type.includes("text/plain") || type.includes("message/rfc822")) return "rfc822";

  // No usable content type: sniff. JSON is unambiguous, RFC822 announces itself
  // with a `From:` header at the start of a line, everything else is form data.
  const trimmed = rawBody.trimStart();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return "json";
  if (/^from:\s*/im.test(rawBody)) return "rfc822";
  if (rawBody.includes("=")) return "form";
  return "rfc822";
}

/** Flattens a JSON object into string fields; drops nested/undefined values. */
function flattenJsonObject(value: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (raw === null || raw === undefined) continue;
    if (typeof raw === "string") {
      out[key] = raw;
    } else if (typeof raw === "number" || typeof raw === "boolean") {
      out[key] = String(raw);
    } else {
      // Objects and arrays (SendGrid's `envelope`, `headers`, attachment lists)
      // are preserved as their JSON text so nothing is silently dropped.
      try {
        out[key] = JSON.stringify(raw);
      } catch {
        /* unserializable value: skip rather than throw */
      }
    }
  }
  return out;
}

/** Parses `application/x-www-form-urlencoded` into string fields. */
function parseFormFields(rawBody: string): Record<string, string> {
  const out: Record<string, string> = {};
  const params = new URLSearchParams(rawBody);
  for (const [key, value] of params.entries()) {
    if (key === "") continue;
    // Repeated keys: keep the first non-empty value, append nothing.
    if (out[key] === undefined || out[key] === "") out[key] = value;
  }
  return out;
}

/**
 * Parses a raw RFC822 message: headers up to the first blank line, body after.
 * Only unstructured header folding is handled (a continuation line begins with
 * whitespace); MIME multipart bodies are passed through as-is.
 */
function parseRfc822(rawBody: string): Record<string, string> {
  const normalized = rawBody.replace(/\r\n/g, "\n");
  const separator = normalized.indexOf("\n\n");
  const headerBlock = separator === -1 ? normalized : normalized.slice(0, separator);
  const body = separator === -1 ? "" : normalized.slice(separator + 2);

  const out: Record<string, string> = {};
  const unfolded: string[] = [];
  for (const line of headerBlock.split("\n")) {
    if (/^\s/.test(line) && unfolded.length > 0) {
      unfolded[unfolded.length - 1] = `${unfolded[unfolded.length - 1]} ${line.trim()}`;
    } else {
      unfolded.push(line);
    }
  }
  for (const line of unfolded) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (name === "") continue;
    if (out[name] === undefined) out[name] = value;
  }
  out.body = body;
  return out;
}

// ---------------------------------------------------------------------------
// Field picking
// ---------------------------------------------------------------------------

interface Picked {
  value: string;
  sourceKey: string;
}

/** Returns the first non-blank field whose canonical name is in `candidates`. */
function pick(fields: Record<string, string>, candidates: readonly string[]): Picked | null {
  for (const candidate of candidates) {
    for (const [key, value] of Object.entries(fields)) {
      if (canonicalKey(key) !== candidate) continue;
      if (isBlank(value)) continue;
      return { value, sourceKey: key };
    }
  }
  return null;
}

/** Strips tags from an HTML body so an HTML-only payload still yields text. */
function htmlToText(html: string): string {
  return html
    .replace(/<\s*(script|style)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, "")
    .replace(/<\s*br\s*\/?\s*>/gi, "\n")
    .replace(/<\s*\/\s*p\s*>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .trim();
}

/** True when the object looks like an already-shaped `RawEmailRecord`. */
function looksLikeRawEmailRecord(value: Record<string, unknown>): boolean {
  const keys = Object.keys(value).map(canonicalKey);
  const hasSender = keys.includes("fromemail") || keys.includes("fromname");
  return hasSender && keys.includes("body");
}

/** Builds a `RawEmailRecord` from an already-shaped object, or `null`. */
function fromRawEmailShape(value: Record<string, unknown>): RawEmailRecord | null {
  const fields = flattenJsonObject(value);
  return assemble(fields);
}

// ---------------------------------------------------------------------------
// Assembly — shared by every dialect
// ---------------------------------------------------------------------------

/**
 * Turns a flat field map into a `RawEmailRecord`, or `null` when no sender
 * address or no body can be found. Consumed keys are removed from the leftover
 * set; everything else lands in `formFields`.
 */
function assemble(fields: Record<string, string>): RawEmailRecord | null {
  const consumed = new Set<string>();

  const emailField = pick(fields, EMAIL_KEYS);
  const nameField = pick(fields, NAME_KEYS);
  const combinedField = pick(fields, COMBINED_SENDER_KEYS);
  const subjectField = pick(fields, SUBJECT_KEYS);
  const bodyField = pick(fields, BODY_KEYS);
  const htmlField = pick(fields, HTML_KEYS);
  const receivedAtField = pick(fields, RECEIVED_AT_KEYS);

  let fromEmail = "";
  let fromName = "";

  if (emailField !== null) {
    const parsed = parseSender(emailField.value);
    if (parsed !== null) {
      fromEmail = parsed.email;
      consumed.add(emailField.sourceKey);
    }
  }
  if (nameField !== null) {
    fromName = collapse(nameField.value);
    consumed.add(nameField.sourceKey);
  }
  if (combinedField !== null) {
    const parsed = parseSender(combinedField.value);
    if (parsed !== null) {
      if (fromEmail === "") fromEmail = parsed.email;
      if (fromName === "") fromName = parsed.name;
      consumed.add(combinedField.sourceKey);
    }
  }

  let body = "";
  if (bodyField !== null) {
    body = bodyField.value;
    consumed.add(bodyField.sourceKey);
  } else if (htmlField !== null) {
    body = htmlToText(htmlField.value);
    consumed.add(htmlField.sourceKey);
  }

  // A sender address and a body are the two things the pipeline cannot run
  // without, and neither may be invented.
  if (fromEmail === "" || body.trim() === "") return null;

  let subject = "";
  if (subjectField !== null) {
    subject = collapse(subjectField.value);
    consumed.add(subjectField.sourceKey);
  }

  let receivedAt: IsoTimestamp | undefined;
  if (receivedAtField !== null) {
    const parsedDate = new Date(receivedAtField.value);
    if (!Number.isNaN(parsedDate.getTime())) {
      receivedAt = parsedDate.toISOString();
      consumed.add(receivedAtField.sourceKey);
    }
  }

  const formFields: Record<string, string> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (consumed.has(key)) continue;
    if (isBlank(value)) continue;
    formFields[key] = value;
  }

  const record: RawEmailRecord = {
    fromName,
    fromEmail,
    subject,
    body,
  };
  if (receivedAt !== undefined) record.receivedAt = receivedAt;
  if (Object.keys(formFields).length > 0) record.formFields = formFields;
  return record;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Normalizes any supported inbound payload into a {@link RawEmailRecord}.
 *
 * @returns the normalized record, or `null` when the payload carries no sender
 *          address or no body. Never throws.
 */
export function parseInboundEmail(input: InboundEmailInput): RawEmailRecord | null {
  const rawBody = typeof input.rawBody === "string" ? input.rawBody : "";
  if (rawBody.trim() === "") return null;

  const kind = detectKind(input.contentType, rawBody);

  try {
    if (kind === "json") {
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawBody);
      } catch {
        // A JSON content type with an unparseable body: fall back to the raw
        // RFC822 reader rather than rejecting outright.
        return assemble(parseRfc822(rawBody));
      }
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        return null;
      }
      const object = parsed as Record<string, unknown>;

      // Shape (b): an explicit `rawEmail` envelope wins over everything else.
      const envelope = object.rawEmail;
      if (envelope !== null && typeof envelope === "object" && !Array.isArray(envelope)) {
        const record = fromRawEmailShape(envelope as Record<string, unknown>);
        if (record !== null) return record;
      }
      // Shape (b) bare, or shape (a) — both are handled by the same assembler,
      // which recognizes `fromEmail`/`fromName` and `from`/`text`/`body` alike.
      if (looksLikeRawEmailRecord(object)) {
        const record = fromRawEmailShape(object);
        if (record !== null) return record;
      }
      return assemble(flattenJsonObject(object));
    }

    if (kind === "form") {
      return assemble(parseFormFields(rawBody));
    }

    return assemble(parseRfc822(rawBody));
  } catch {
    // Defense in depth: this module's contract is "never throws".
    return null;
  }
}
