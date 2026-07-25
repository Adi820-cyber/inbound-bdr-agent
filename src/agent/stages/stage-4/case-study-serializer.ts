/**
 * Case-study serializer (Req 7.4, 7.5).
 *
 * Renders any `CaseStudyRecord` into a single canonical string using a fixed
 * field order, and parses that string back into an equal record. Absent values
 * are already the literal `"unknown"` in the record (Req 7.3) and are written
 * verbatim.
 *
 * The canonical form is the nine fields — in the exact order declared by
 * `CaseStudyRecord` — joined by a single field delimiter. Every field value is
 * escaped so that the delimiter, the escape character itself, and newlines can
 * appear inside a value without breaking the framing. Because escaping is fully
 * reversible and the field count is fixed, `parseCaseStudy(serializeCaseStudy(r))`
 * is structurally equal to `r` for ANY record, including records whose values
 * contain the delimiter, embedded newlines, unicode, or the string `"unknown"`
 * (Req 7.5, Property 20).
 */

import type { CaseStudyRecord, IsoTimestamp, Maybe, VerificationStatus } from "../../contracts";

/**
 * Field delimiter. A never-unescaped occurrence of this character separates the
 * nine canonical fields. Any occurrence inside a value is escaped.
 */
const FIELD_DELIMITER = "\u001f"; // ASCII Unit Separator — rare in real content

/** Escape character used to protect the delimiter, itself, and line breaks. */
const ESCAPE = "\\";

/**
 * Fixed field order. This MUST match the declaration order of `CaseStudyRecord`
 * and is the canonical contract between serializer and parser. Changing it is a
 * breaking change to the serialized form.
 */
const FIELD_ORDER = [
  "sourceUrl",
  "title",
  "industry",
  "region",
  "useCase",
  "namedPartner",
  "statedResults",
  "verificationStatus",
  "retrievedAt",
] as const;

const FIELD_COUNT = FIELD_ORDER.length;

/**
 * Escape a single field value. The escape character is doubled first so that
 * the subsequent escape sequences we introduce can never be confused with a
 * pre-existing `ESCAPE` in the value.
 *
 *  - `ESCAPE`          → `ESCAPE ESCAPE`
 *  - `FIELD_DELIMITER` → `ESCAPE + "d"`
 *  - `"\n"`            → `ESCAPE + "n"`
 *  - `"\r"`            → `ESCAPE + "r"`
 */
function escapeField(value: string): string {
  let out = "";
  for (const ch of value) {
    switch (ch) {
      case ESCAPE:
        out += ESCAPE + ESCAPE;
        break;
      case FIELD_DELIMITER:
        out += ESCAPE + "d";
        break;
      case "\n":
        out += ESCAPE + "n";
        break;
      case "\r":
        out += ESCAPE + "r";
        break;
      default:
        out += ch;
    }
  }
  return out;
}

/** Reverse of {@link escapeField}. Throws on a dangling or unknown escape. */
function unescapeField(value: string): string {
  let out = "";
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch !== ESCAPE) {
      out += ch;
      continue;
    }
    const next = value[i + 1];
    if (next === undefined) {
      throw new Error("Case-study parse error: dangling escape character");
    }
    switch (next) {
      case ESCAPE:
        out += ESCAPE;
        break;
      case "d":
        out += FIELD_DELIMITER;
        break;
      case "n":
        out += "\n";
        break;
      case "r":
        out += "\r";
        break;
      default:
        throw new Error(`Case-study parse error: unknown escape sequence "\\${next}"`);
    }
    i++; // consumed the escaped character
  }
  return out;
}

/**
 * Serialize a `CaseStudyRecord` into its canonical fixed-field-order string.
 * Absent values are the literal `"unknown"` in the record and are written as-is.
 */
export function serializeCaseStudy(record: CaseStudyRecord): string {
  const values: string[] = [
    record.sourceUrl,
    record.title,
    record.industry,
    record.region,
    record.useCase,
    record.namedPartner,
    record.statedResults,
    record.verificationStatus,
    record.retrievedAt,
  ];
  return values.map(escapeField).join(FIELD_DELIMITER);
}

/**
 * Parse a canonical serialized string back into a `CaseStudyRecord`.
 *
 * Splits on unescaped delimiters (escaped delimiters live inside fields and are
 * restored by {@link unescapeField}), requiring exactly {@link FIELD_COUNT}
 * fields. Because every field — including empty strings and values containing
 * the delimiter — is framed by escaping rather than by content, the split is
 * unambiguous.
 */
export function parseCaseStudy(serialized: string): CaseStudyRecord {
  const rawFields = splitOnUnescapedDelimiter(serialized);
  if (rawFields.length !== FIELD_COUNT) {
    throw new Error(
      `Case-study parse error: expected ${FIELD_COUNT} fields, got ${rawFields.length}`,
    );
  }
  const fields = rawFields.map(unescapeField) as [
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
  ];

  return {
    sourceUrl: fields[0],
    title: fields[1] as Maybe<string>,
    industry: fields[2] as Maybe<string>,
    region: fields[3] as Maybe<string>,
    useCase: fields[4] as Maybe<string>,
    namedPartner: fields[5] as Maybe<string>,
    statedResults: fields[6] as Maybe<string>,
    verificationStatus: fields[7] as VerificationStatus,
    retrievedAt: fields[8] as Maybe<IsoTimestamp>,
  };
}

/**
 * Split on delimiters that are not preceded by an active escape. An escape is
 * "active" only when it is not itself escaped, so `ESCAPE ESCAPE FIELD_DELIMITER`
 * is a real field boundary while `ESCAPE FIELD_DELIMITER` (i.e. `\d`) is not.
 */
function splitOnUnescapedDelimiter(serialized: string): string[] {
  const fields: string[] = [];
  let current = "";
  let escaped = false;
  for (const ch of serialized) {
    if (escaped) {
      // Delimiter reached via an escape belongs to the field; keep both chars
      // so unescapeField can reverse the sequence.
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === ESCAPE) {
      current += ch;
      escaped = true;
      continue;
    }
    if (ch === FIELD_DELIMITER) {
      fields.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  fields.push(current);
  return fields;
}
