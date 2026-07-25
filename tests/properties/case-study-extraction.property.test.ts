/**
 * Property 19: Case-study extraction is total.
 *
 * **Validates: Requirements 7.2, 7.3**
 *
 * For ANY retrieved page text — empty, non-HTML, unicode, delimiter-laden, very
 * long — and for ANY LLM behavior — a schema-valid extraction, a partial /
 * empty-field extraction, a schema-violating (malformed) value, or a thrown
 * error — `extractCaseStudyFromText` produces a `CaseStudyRecord` in which all
 * seven string fields (`sourceUrl` plus the six content fields) are present and
 * each is either a non-empty value or exactly `"unknown"`, and it never throws.
 *
 * The same totality holds for the page loop `extractCaseStudiesFromPages`: for
 * ANY list of URLs and ANY per-page fetch outcome — a fetched page, a `null`
 * (failed/aborted fetch), or a `fetchPage` that throws — it returns exactly one
 * schema-valid record per input URL, in input order, and never throws.
 *
 * Every produced record is validated against `caseStudyRecordSchema`, the
 * authoritative shape from `src/agent/schemas.ts`. The LLM is always the
 * `createStubLlmProvider` test double, so no test reaches a live model.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { UNKNOWN, type CaseStudyRecord, type StageEvent } from "@/agent/contracts";
import { caseStudyRecordSchema } from "@/agent/schemas";
import {
  extractCaseStudiesFromPages,
  extractCaseStudyFromText,
} from "@/agent/stages/stage-4/case-study-extractor";
import type { ToolbeltEmit } from "@/research/toolbelt";
import {
  createStubLlmProvider,
  makeFetchedPage,
  type StubLlmResponder,
} from "@tests/support/stub-llm";
import { arbEdgeString } from "@tests/properties/arbitraries";

// ---------------------------------------------------------------------------
// Shared generators
// ---------------------------------------------------------------------------

/**
 * The six content fields an extraction returns. Values reach every edge case
 * (empty string, the literal `"unknown"`, unicode, delimiters, very long) so
 * the caller-side normalization (`""` → `"unknown"`) is exercised.
 */
const arbExtractionFields = fc.record({
  title: arbEdgeString,
  industry: arbEdgeString,
  region: arbEdgeString,
  useCase: arbEdgeString,
  namedPartner: arbEdgeString,
  statedResults: arbEdgeString,
});

/** A non-empty source URL: `sourceUrl` is copied verbatim, so it must be non-empty. */
const arbNonEmptyUrl: fc.Arbitrary<string> = fc.oneof(
  fc.webUrl(),
  fc.constantFrom(
    "unknown",
    "not a url at all",
    "https://例え.テスト/パス",
    "HTTPS://UPPER.EXAMPLE.COM/PATH",
    "https://example.com/case-study/" + "x".repeat(400),
  ),
);

const arbVerificationStatus: fc.Arbitrary<CaseStudyRecord["verificationStatus"]> =
  fc.constantFrom("verified", "unknown", "stale");

const arbMaybeRetrievedAt: fc.Arbitrary<CaseStudyRecord["retrievedAt"]> = fc.oneof(
  fc.integer({ min: 0, max: 4102444800000 }).map((ms) => new Date(ms).toISOString()),
  fc.constant(UNKNOWN),
);

/**
 * The four LLM behaviors Property 19 must survive:
 *  - `valid` / `partial`: a schema-valid object (partial = empty/unknown fields),
 *  - `malformed_missing`: an object missing required fields (fails schema.parse),
 *  - `malformed_type`: a non-object value (fails schema.parse),
 *  - `throws`: the model call throws.
 * Each maps to a `respondWith` script for `createStubLlmProvider`.
 */
type LlmBehavior =
  | { kind: "valid"; fields: Record<string, string> }
  | { kind: "malformed_missing" }
  | { kind: "malformed_type" }
  | { kind: "throws" };

const arbLlmBehavior: fc.Arbitrary<LlmBehavior> = fc.oneof(
  arbExtractionFields.map((fields) => ({ kind: "valid" as const, fields })),
  fc.constant({ kind: "malformed_missing" as const }),
  fc.constant({ kind: "malformed_type" as const }),
  fc.constant({ kind: "throws" as const }),
);

function responderFor(behavior: LlmBehavior): StubLlmResponder {
  switch (behavior.kind) {
    case "valid":
      return () => behavior.fields;
    case "malformed_missing":
      // Missing required fields -> the stub's schema.parse throws.
      return () => ({}) as unknown;
    case "malformed_type":
      // A non-object value -> the stub's schema.parse throws.
      return () => 42 as unknown;
    case "throws":
      return () => {
        throw new Error("simulated LLM failure");
      };
  }
}

/** A no-op emit sink; totality does not depend on what the events carry. */
const noopEmit: ToolbeltEmit = (_event: Omit<
  StageEvent,
  "seq" | "eventId" | "runId" | "timestamp"
>) => {};

// The seven string fields Property 19 constrains: sourceUrl + six content fields.
const SEVEN_FIELDS = [
  "sourceUrl",
  "title",
  "industry",
  "region",
  "useCase",
  "namedPartner",
  "statedResults",
] as const;

/**
 * Assert a record satisfies Property 19: schema-valid, `sourceUrl` echoes the
 * request, and each of the seven string fields is a non-empty value or exactly
 * `"unknown"`.
 */
function assertTotalRecord(record: CaseStudyRecord, expectedSourceUrl: string): void {
  // Authoritative shape check (Req 7.2/7.3).
  expect(() => caseStudyRecordSchema.parse(record)).not.toThrow();

  expect(record.sourceUrl).toBe(expectedSourceUrl);

  for (const field of SEVEN_FIELDS) {
    const value = record[field];
    expect(typeof value).toBe("string");
    const isUnknown = value === UNKNOWN;
    const isNonEmpty = typeof value === "string" && value.length > 0;
    expect(isUnknown || isNonEmpty).toBe(true);
  }

  // The remaining fields are always present too.
  expect(record.verificationStatus).toBeDefined();
  expect(record.retrievedAt).toBeDefined();
}

// ---------------------------------------------------------------------------
// Property 19
// ---------------------------------------------------------------------------

describe("Property 19: Case-study extraction is total", () => {
  it("extractCaseStudyFromText yields a complete record for any text and any LLM behavior", async () => {
    await fc.assert(
      fc.asyncProperty(
        arbNonEmptyUrl,
        arbEdgeString, // page text: empty, non-HTML, unicode, delimiters, very long
        arbMaybeRetrievedAt,
        arbVerificationStatus,
        arbLlmBehavior,
        async (sourceUrl, pageText, retrievedAt, verificationStatus, behavior) => {
          const llm = createStubLlmProvider({ respondWith: responderFor(behavior) });

          const record = await extractCaseStudyFromText({
            sourceUrl,
            pageText,
            retrievedAt,
            verificationStatus,
            llm,
          });

          assertTotalRecord(record, sourceUrl);

          // A malformed / throwing model degrades to the all-"unknown" content
          // shape rather than propagating a failure.
          if (behavior.kind !== "valid") {
            expect(record.title).toBe(UNKNOWN);
            expect(record.industry).toBe(UNKNOWN);
            expect(record.region).toBe(UNKNOWN);
            expect(record.useCase).toBe(UNKNOWN);
            expect(record.namedPartner).toBe(UNKNOWN);
            expect(record.statedResults).toBe(UNKNOWN);
          }
        },
      ),
    );
  });

  it("extractCaseStudiesFromPages returns exactly one record per URL under any fetch outcome", async () => {
    // Per URL: a fetched page, a null (failed fetch), or a throwing fetchPage.
    const arbFetchOutcome = fc.oneof(
      fc.constant({ type: "null" as const }),
      fc.constant({ type: "throw" as const }),
      fc.record({
        type: fc.constant("page" as const),
        text: arbEdgeString,
        statusCode: fc.integer({ min: 100, max: 599 }),
        fromCache: fc.boolean(),
        retrievedAt: fc
          .integer({ min: 0, max: 4102444800000 })
          .map((ms) => new Date(ms).toISOString()),
      }),
    );

    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.tuple(arbNonEmptyUrl, arbFetchOutcome), { maxLength: 8 }),
        arbLlmBehavior,
        async (pairs, behavior) => {
          const urls = pairs.map(([url]) => url);
          const outcomes = pairs.map(([, outcome]) => outcome);

          // fetchPage is called once per URL, in order; drive it off a counter
          // so duplicate URLs still get their own scripted outcome.
          let index = 0;
          const toolbelt = {
            async fetchPage(url: string) {
              const outcome = outcomes[index++] ?? { type: "null" as const };
              if (outcome.type === "throw") {
                throw new Error("simulated fetch failure");
              }
              if (outcome.type === "null") {
                return null;
              }
              return makeFetchedPage({
                requestedUrl: url,
                finalUrl: url,
                statusCode: outcome.statusCode,
                text: outcome.text,
                retrievedAt: outcome.retrievedAt,
                fromCache: outcome.fromCache,
              });
            },
          };

          const llm = createStubLlmProvider({ respondWith: responderFor(behavior) });

          const records = await extractCaseStudiesFromPages(urls, {
            toolbelt,
            llm,
            emit: noopEmit,
          });

          // Exactly one record per input URL, in input order.
          expect(records).toHaveLength(urls.length);
          for (let i = 0; i < urls.length; i++) {
            const record = records[i]!;
            assertTotalRecord(record, urls[i]!);
          }
        },
      ),
    );
  });
});
