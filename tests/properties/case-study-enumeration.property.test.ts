/**
 * Property 18: Case-study URL enumeration is safe and same-origin (Req 7.1).
 *
 * Feature: inbound-bdr-agent, Property 18: For ANY HTML document — including
 * malformed markup, relative and protocol-relative hrefs, duplicate links,
 * fragment-only links, off-origin links, and adversarial URL shapes
 * (`javascript:`, `data:`, `mailto:`, ...) — and ANY base URL,
 * `enumerateCaseStudyUrls`:
 *
 *   1. NEVER throws;
 *   2. returns only absolute, same-origin, http(s) URLs whose path matches the
 *      case-study page pattern;
 *   3. contains no duplicates after normalization; and
 *   4. never exceeds `maxPages`.
 *
 * The HTML generator (`arbHtmlWithMixedAnchors`) deliberately assembles anchor
 * fragments that mix same-origin case-study links, off-origin links,
 * protocol-relative links, `javascript:`/`mailto:`/`data:` links, fragment-only
 * links, and non-case-study same-origin links, interleaved with malformed markup
 * and `arbEdgeString` noise, so every called-out shape is exercised.
 */

import fc from "fast-check";
import { describe, expect, test } from "vitest";

import {
  enumerateCaseStudyUrls,
  extractAnchorHrefs,
} from "@/agent/stages/stage-4/case-study-extractor";
import { normalizeUrl } from "@/research/fetch-ledger";

import { arbEdgeString, arbUrl } from "./arbitraries";

// A same-origin case-study *page* path (mirrors the extractor's own pattern):
// `/case-study/<slug>` or `/case-studies/<slug>` with a non-empty slug.
const CASE_STUDY_PATH_RE = /^\/case-stud(?:y|ies)\/[^/].*/i;

// The origins the base URL is drawn from. Enumeration is same-origin, so every
// returned URL must share exactly one of these origins with its base.
const BASE_ORIGINS = [
  "https://www.flytbase.com",
  "https://flytbase.com",
  "http://example.org",
  "https://sub.example.com:8443",
] as const;

// A base URL: an origin from the set above plus a case-studies index path.
const arbBaseUrl: fc.Arbitrary<string> = fc
  .tuple(
    fc.constantFrom(...BASE_ORIGINS),
    fc.constantFrom("/case-studies", "/case-studies/", "/resources/case-studies", "/"),
  )
  .map(([origin, path]) => origin + path);

// URL-safe slug so constructed case-study links stay well-formed.
const arbSlug: fc.Arbitrary<string> = fc
  .string({ minLength: 1, maxLength: 24 })
  .map((s) => s.replace(/[^a-zA-Z0-9-]/g, "-").replace(/^-+|-+$/g, ""))
  .filter((s) => s.length > 0);

// A single href of one of the interesting shapes. Some resolve to a valid
// same-origin case-study URL; most are decoys that must be filtered out.
const arbHref: fc.Arbitrary<string> = fc.oneof(
  // Relative same-origin case-study pages (SHOULD be kept).
  arbSlug.map((s) => `/case-studies/${s}`),
  arbSlug.map((s) => `/case-study/${s}`),
  arbSlug.map((s) => `/case-studies/${s}?utm_source=x#section`),
  // Same-origin but NOT a case-study page (must be dropped).
  fc.constantFrom("/case-studies", "/case-studies/", "/about", "/", "/blog/post-1"),
  // Off-origin absolute (must be dropped).
  arbSlug.map((s) => `https://competitor.example.net/case-studies/${s}`),
  // Protocol-relative (resolves against base protocol; off-origin here).
  arbSlug.map((s) => `//other-host.example.com/case-studies/${s}`),
  // Non-http schemes and fragment-only (must be dropped).
  fc.constantFrom(
    "javascript:alert(document.cookie)",
    "mailto:sales@example.com",
    "tel:+15551234",
    "data:text/html,<h1>x</h1>",
    "#top",
    "#",
  ),
  // Fully adversarial URL shapes.
  arbUrl,
);

// Wrap an href in an anchor tag using one of several (some malformed) shapes.
const arbAnchorFragment: fc.Arbitrary<string> = fc
  .tuple(arbHref, fc.integer({ min: 0, max: 5 }))
  .map(([href, shape]) => {
    switch (shape) {
      case 0:
        return `<a href="${href}">link</a>`;
      case 1:
        return `<a href='${href}'>link</a>`;
      case 2:
        return `<a class="btn" href=${href} data-x>link`; // unquoted, unclosed
      case 3:
        return `<A HREF="${href}" >LINK</A>`; // uppercase tag
      case 4:
        return `<a\n  href="${href}"\n  rel="noopener">link</a>`; // multiline
      default:
        return `<a href="${href}"`; // truncated / malformed
    }
  });

// A whole HTML document: mixed anchors interleaved with edge-string noise and
// malformed markup. Any string is valid input, so we splice arbitrary noise in.
const arbHtmlWithMixedAnchors: fc.Arbitrary<string> = fc
  .array(fc.oneof(arbAnchorFragment, arbEdgeString), { maxLength: 30 })
  .map(
    (parts) =>
      `<html><body><div class="grid">${parts.join(
        "<span>&nbsp;</span>",
      )}</div></body></html>`,
  );

// A page cap, including degenerate values enumeration must tolerate.
const arbMaxPages: fc.Arbitrary<number> = fc.oneof(
  fc.integer({ min: 1, max: 50 }),
  fc.constantFrom(0, -1, -100, 3.7, Number.NaN, Number.POSITIVE_INFINITY),
);

describe("case-study URL enumeration safety (Property 18)", () => {
  // Validates: Requirements 7.1
  test("enumeration returns only absolute same-origin case-study URLs, deduped, capped, without throwing", () => {
    fc.assert(
      fc.property(
        arbHtmlWithMixedAnchors,
        arbBaseUrl,
        arbMaxPages,
        (html, baseUrl, maxPages) => {
          // Invariant 1: never throws.
          const urls = enumerateCaseStudyUrls(html, baseUrl, maxPages);

          expect(Array.isArray(urls)).toBe(true);

          const base = new URL(baseUrl);
          const cap = Number.isFinite(maxPages) ? Math.max(0, Math.floor(maxPages)) : 0;

          // Invariant 4: never exceeds the (floored, non-negative) cap.
          expect(urls.length).toBeLessThanOrEqual(cap);

          const normalizedSeen = new Set<string>();
          for (const url of urls) {
            // Invariant 2a: each result is an absolute, parseable URL.
            const parsed = new URL(url);

            // Invariant 2b: http(s) only.
            expect(["http:", "https:"]).toContain(parsed.protocol);

            // Invariant 2c: same-origin as the base index.
            expect(parsed.origin).toBe(base.origin);
            expect(parsed.protocol).toBe(base.protocol);

            // Invariant 2d: path matches the case-study page pattern.
            expect(CASE_STUDY_PATH_RE.test(parsed.pathname)).toBe(true);

            // Invariant 3: no duplicates after normalization.
            const key = normalizeUrl(url);
            expect(normalizedSeen.has(key)).toBe(false);
            normalizedSeen.add(key);
          }
        },
      ),
      { numRuns: 500 },
    );
  });

  // Validates: Requirements 7.1 — totality across ANY string inputs and caps.
  test("enumeration never throws for arbitrary html, base URL, and cap", () => {
    fc.assert(
      fc.property(arbEdgeString, arbEdgeString, arbMaxPages, (html, baseUrl, maxPages) => {
        const urls = enumerateCaseStudyUrls(html, baseUrl, maxPages);
        expect(Array.isArray(urls)).toBe(true);
        // An unparseable / non-http base yields nothing to crawl.
        const cap = Number.isFinite(maxPages) ? Math.max(0, Math.floor(maxPages)) : 0;
        expect(urls.length).toBeLessThanOrEqual(cap);
      }),
      { numRuns: 300 },
    );
  });

  // Validates: Requirements 7.1 — the anchor extractor underneath is also total.
  test("extractAnchorHrefs never throws for any string", () => {
    fc.assert(
      fc.property(fc.oneof(arbHtmlWithMixedAnchors, arbEdgeString), (html) => {
        const hrefs = extractAnchorHrefs(html);
        expect(Array.isArray(hrefs)).toBe(true);
        for (const href of hrefs) {
          expect(typeof href).toBe("string");
        }
      }),
      { numRuns: 300 },
    );
  });
});
