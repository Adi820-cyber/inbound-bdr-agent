/**
 * Repository hygiene static tests (task 19.4).
 *
 * These assertions read the repository from disk rather than importing modules:
 * they are invariants about the *shape of the repo*, not about runtime behavior,
 * and each one guards a requirement that a careless edit could silently break.
 *
 * - Req 14.2 — secrets never enter version control: `.gitignore` covers every
 *   `.env` variant and the local run store, and `.env.example` carries only
 *   placeholders (never a real-looking key).
 * - Req 13.1 / 13.6 — one file per stage, at the exact paths the README's
 *   stage table claims.
 * - Req 8.8 — the scoring rubric and the GTM decision module are lead-agnostic:
 *   no Fixed_Lead identifying literal may appear in either.
 * - Req 13.4 — raw web egress is confined to the Research Toolbelt and the
 *   provider adapters (plus same-origin browser calls from the UI); the agent
 *   layer never calls `fetch` itself.
 * - Req 14.6 — no secret-bearing variable name is exposed through the
 *   `NEXT_PUBLIC_` prefix anywhere in `src/`.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Reads a repo-relative text file. */
function readRepoFile(relativePath: string): string {
  return readFileSync(join(REPO_ROOT, relativePath), "utf8");
}

/** True when a repo-relative path exists as a file. */
function isFile(relativePath: string): boolean {
  try {
    return statSync(join(REPO_ROOT, relativePath)).isFile();
  } catch {
    return false;
  }
}

/** Every file under a repo-relative directory, as POSIX repo-relative paths. */
function walkFiles(relativeDir: string): string[] {
  const absoluteRoot = join(REPO_ROOT, relativeDir);
  const out: string[] = [];

  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        out.push(relative(REPO_ROOT, full).split(sep).join("/"));
      }
    }
  };

  walk(absoluteRoot);
  return out;
}

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];

const isSourceFile = (path: string): boolean =>
  SOURCE_EXTENSIONS.some((ext) => path.endsWith(ext));

/**
 * Drops block comments and comment-only lines so prose ("a `null` fetch (…)")
 * cannot masquerade as a call site. Code lines are left untouched, so a real
 * call is never hidden.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split(/\r?\n/)
    .filter((line) => !/^\s*(\/\/|\*)/.test(line))
    .join("\n");
}

// ---------------------------------------------------------------------------
// Req 14.2 — .gitignore keeps secrets and the local run store out of git
// ---------------------------------------------------------------------------

describe("Req 14.2: .gitignore excludes secrets and local run data", () => {
  const entries = readRepoFile(".gitignore")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));

  it.each([".env", ".env.local", ".env.*.local", ".data/"])(
    "ignores %s",
    (pattern) => {
      expect(entries).toContain(pattern);
    },
  );
});

// ---------------------------------------------------------------------------
// Req 14.3 / 14.2 — .env.example is placeholders only
// ---------------------------------------------------------------------------

describe("Req 14.2: .env.example contains no real-looking secret values", () => {
  const raw = readRepoFile(".env.example");

  /** `KEY=value` pairs, comments and blank lines dropped. */
  const assignments = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .map((line) => {
      const eq = line.indexOf("=");
      return { key: line.slice(0, eq), value: line.slice(eq + 1).trim() };
    });

  /** Shapes that only a real credential has. */
  const SECRET_SHAPES: Array<{ label: string; pattern: RegExp }> = [
    { label: "OpenAI-style key prefix (sk-)", pattern: /\bsk-[A-Za-z0-9_-]{8,}/ },
    { label: "OpenRouter key prefix (sk-or-v1-)", pattern: /\bsk-or-v1-/ },
    { label: "Tavily key prefix (tvly-)", pattern: /\btvly-/ },
    { label: "long hex string", pattern: /\b[0-9a-fA-F]{32,}\b/ },
    {
      label: "uuid",
      pattern:
        /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/,
    },
    { label: "AWS access key id", pattern: /\bA(?:KIA|SIA)[0-9A-Z]{16}\b/ },
  ];

  it("parses at least one assignment (guards the parser itself)", () => {
    expect(assignments.length).toBeGreaterThan(0);
  });

  it("exposes every secret-bearing variable as a placeholder", () => {
    const secretKeys = assignments.filter(({ key }) =>
      /(API_KEY|_TOKEN|_SECRET|_KEY)$/.test(key),
    );

    expect(secretKeys.length).toBeGreaterThan(0);

    for (const { key, value } of secretKeys) {
      // `your-...` is the template's placeholder convention.
      expect(value, `${key} must be a placeholder`).toMatch(/^your-[a-z0-9-]+$/);
    }
  });

  it.each(SECRET_SHAPES)("contains no $label", ({ pattern }) => {
    expect(raw).not.toMatch(pattern);
  });
});

// ---------------------------------------------------------------------------
// Req 13.1 / 13.6 — the six stage files exist where the README says they do
// ---------------------------------------------------------------------------

describe("Req 13.1: one source file per stage, at the README's paths", () => {
  const EXPECTED_STAGE_FILES = [
    "src/agent/stages/stage-1-qualifier.ts",
    "src/agent/stages/stage-2-researcher.ts",
    "src/agent/stages/stage-3-responder.ts",
    "src/agent/stages/stage-4-matcher.ts",
    "src/agent/stages/stage-5-gtm-advisor.ts",
    "src/agent/stages/stage-6-handoff-generator.ts",
  ];

  it.each(EXPECTED_STAGE_FILES)("%s exists", (path) => {
    expect(isFile(path)).toBe(true);
  });

  it("declares exactly these six stage paths in the README table", () => {
    const readme = readRepoFile("README.md");
    const claimed = [
      ...readme.matchAll(/`(src\/agent\/stages\/stage-[1-6]-[a-z0-9-]+\.ts)`/g),
    ].map((match) => match[1]!);

    expect([...new Set(claimed)].sort()).toEqual([...EXPECTED_STAGE_FILES].sort());
  });

  it("every README-claimed stage path resolves on disk", () => {
    const readme = readRepoFile("README.md");
    const claimed = [
      ...new Set(
        [...readme.matchAll(/`(src\/[A-Za-z0-9._/-]+\.tsx?)`/g)].map((m) => m[1]!),
      ),
    ];

    expect(claimed.length).toBeGreaterThan(0);
    expect(claimed.filter((path) => !isFile(path))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Req 8.8 — the rubric and the GTM decision module are lead-agnostic
// ---------------------------------------------------------------------------

describe("Req 8.8: no Fixed_Lead literal in the rubric or the GTM decision module", () => {
  const LEAD_AGNOSTIC_MODULES = [
    "src/agent/stages/stage-4/scoring-rubric.ts",
    "src/agent/stages/stage-5/gtm-decision.ts",
  ];

  const FIXED_LEAD_LITERALS = [
    "SQM",
    "Rodrigo",
    "Castillo",
    "Anglo American",
    "r.castillo",
    "sqm.cl",
  ];

  it.each(LEAD_AGNOSTIC_MODULES)("%s names no lead-specific entity", (path) => {
    expect(isFile(path)).toBe(true);
    const source = readRepoFile(path);

    const found = FIXED_LEAD_LITERALS.filter((literal) =>
      source.toLowerCase().includes(literal.toLowerCase()),
    );

    expect(found).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Req 13.4 — raw web egress stays in the toolbelt and the provider adapters
// ---------------------------------------------------------------------------

describe("Req 13.4: raw fetch is confined to the allowed directories", () => {
  /**
   * A bare `fetch(` call. The lookbehind excludes qualified or differently
   * named callees (`doFetch(`, `toolbelt.fetchPage(`, `globalThis.fetch(`),
   * which are separately covered: the wrapper functions live in the toolbelt
   * and a `globalThis.fetch` reference is caught by the second pattern below.
   */
  const BARE_FETCH = /(?<![A-Za-z0-9_$.])fetch\(/;
  const GLOBAL_FETCH = /(?:globalThis|window|global)\s*\.\s*fetch\b/;

  /** Web egress owners plus the client-side dirs that call our own /api routes. */
  const ALLOWED_PREFIXES = [
    "src/research/",
    "src/providers/",
    "src/app/",
    "src/components/",
    "src/hooks/",
  ];

  const sourceFiles = walkFiles("src").filter(isSourceFile);

  it("finds source files to scan (guards the walker itself)", () => {
    expect(sourceFiles.length).toBeGreaterThan(0);
  });

  it("no file outside the allowed directories calls fetch", () => {
    const offenders = sourceFiles.filter((path) => {
      if (ALLOWED_PREFIXES.some((prefix) => path.startsWith(prefix))) return false;
      const source = stripComments(readRepoFile(path));
      return BARE_FETCH.test(source) || GLOBAL_FETCH.test(source);
    });

    expect(offenders).toEqual([]);
  });

  it("no file under src/agent calls fetch", () => {
    const offenders = sourceFiles
      .filter((path) => path.startsWith("src/agent/"))
      .filter((path) => {
        const source = stripComments(readRepoFile(path));
        return BARE_FETCH.test(source) || GLOBAL_FETCH.test(source);
      });

    expect(offenders).toEqual([]);
  });

  it("no source file imports a third-party HTTP client", () => {
    const BANNED_MODULES =
      /\bfrom\s+["'](axios|undici|node-fetch|got|superagent|request|node:https?|https?)["']|\brequire\(\s*["'](axios|undici|node-fetch|got|superagent|request|node:https?|https?)["']\s*\)/;

    const offenders = sourceFiles.filter((path) =>
      BANNED_MODULES.test(stripComments(readRepoFile(path))),
    );

    expect(offenders).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Req 14.6 — no secret is exposed through a NEXT_PUBLIC_ variable name
// ---------------------------------------------------------------------------

describe("Req 14.6: no NEXT_PUBLIC_ variable carries a secret-looking name", () => {
  const PUBLIC_SECRET_NAME = /NEXT_PUBLIC_[A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|KEY)\b/;

  const scanned = [...walkFiles("src").filter(isSourceFile), ".env.example"];

  it("finds files to scan (guards the walker itself)", () => {
    expect(scanned.length).toBeGreaterThan(1);
  });

  it("names no secret-bearing NEXT_PUBLIC_ variable", () => {
    const offenders = scanned.filter((path) =>
      PUBLIC_SECRET_NAME.test(readRepoFile(path)),
    );

    expect(offenders).toEqual([]);
  });
});
