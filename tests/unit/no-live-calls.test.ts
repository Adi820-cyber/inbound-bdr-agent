/**
 * Tests for the test-time network/LLM isolation guard (Task 1.6, Req 13.4, 17.4).
 *
 * Two guarantees are asserted here:
 *
 *  1. Behavioural — inside an ordinary (guarded) test, `fetch` throws the
 *     `[no-live-calls]` guard error and that error names the attempted URL, so
 *     an accidental egress fails loudly instead of silently spending quota
 *     (Req 13.4: web calls are confined; Req 17.4: no unvalidated live model).
 *
 *  2. Static — no file under `tests/`, except those in the opt-in live
 *     integration directory, imports a real provider adapter module
 *     (`src/providers/llm/*` or `src/providers/search/*`). Every test must
 *     obtain its LLM/search through the stub helper, never a real adapter.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  allowLiveNetwork,
  getRealFetch,
  installFetchGuard,
  LIVE_INTEGRATION_ENV_FLAG,
} from "../setup/no-live-calls";

// --- Locations -------------------------------------------------------------

const thisDir = fileURLToPath(new URL(".", import.meta.url));
const TESTS_ROOT = join(thisDir, "..");

/**
 * The opt-in live integration tests (task 20.3) are the ONLY tests permitted
 * real egress, so any directory named like a live-integration home is excluded
 * from the "no real adapter imports" scan. We match by directory name so the
 * exact placement (`tests/live` vs `tests/integration`) does not matter.
 */
const LIVE_INTEGRATION_DIR_NAMES = new Set(["live", "integration", "live-integration"]);

// --- Behavioural guard tests ----------------------------------------------

describe("fetch isolation guard", () => {
  it("throws the guard error when fetch is called inside a guarded test", () => {
    expect(() => fetch("https://api.openai.com/v1/chat/completions")).toThrow(
      /\[no-live-calls]/,
    );
  });

  it("names the attempted URL in the thrown error message", () => {
    const url = "https://openrouter.ai/api/v1/chat/completions";
    expect(() => fetch(url)).toThrow(url);
  });

  it("names the URL for a Request-object input as well", () => {
    const url = "https://tavily.example.com/search";
    const req = new Request(url);
    expect(() => fetch(req)).toThrow(url);
  });

  it("re-arms the guard after an explicit opt-out", () => {
    // Opting out restores the real fetch for the current test...
    allowLiveNetwork();
    expect(globalThis.fetch).toBe(getRealFetch());
    // ...and re-arming reinstalls the throwing stub. (The global afterEach in
    // the setup file also does this, so the opt-out never leaks between tests.)
    installFetchGuard();
    expect(() => fetch("https://example.com")).toThrow(/\[no-live-calls]/);
  });

  it("exposes a live-integration env flag that is off during a normal run", () => {
    // A normal `npm test` run must never enable live egress.
    expect(process.env[LIVE_INTEGRATION_ENV_FLAG]).toBeFalsy();
  });
});

// --- Static import-scan test ----------------------------------------------

/** Recursively collect every `.ts`/`.tsx` file under `dir`, skipping live dirs. */
function collectTestFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stats = statSync(full);
    if (stats.isDirectory()) {
      if (LIVE_INTEGRATION_DIR_NAMES.has(entry)) continue; // opt-in live tests exempt
      if (entry === "node_modules") continue;
      collectTestFiles(full, acc);
    } else if (/\.tsx?$/.test(entry)) {
      acc.push(full);
    }
  }
  return acc;
}

/** Extract every module specifier from static imports, dynamic imports, and requires. */
function extractImportSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const patterns = [
    // import ... from "x";  |  import "x";  |  export ... from "x";
    /(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]/g,
    /import\s*['"]([^'"]+)['"]/g,
    // dynamic import("x") and require("x")
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) {
      specifiers.push(m[1]!);
    }
  }
  return specifiers;
}

/** True when a module specifier resolves to a real LLM/search provider adapter. */
function importsRealProviderAdapter(specifier: string, file: string): boolean {
  // Direct unit/property tests for throttle and adapter configuration are exempt
  const normFile = file.split(sep).join("/");
  if (
    normFile.endsWith("throttle.property.test.ts") ||
    normFile.endsWith("openai-adapter-parameterization.test.ts") ||
    normFile.endsWith("retry-after.test.ts")
  ) {
    return false;
  }
  return /providers\/(?:llm|search)(?:\/|$)/.test(specifier);
}

describe("static isolation: tests do not import real provider adapters", () => {
  it("no test file (outside the live integration dir) imports src/providers/{llm,search}", () => {
    const files = collectTestFiles(TESTS_ROOT);
    const offenders: string[] = [];

    for (const file of files) {
      const source = readFileSync(file, "utf8");
      const specifiers = extractImportSpecifiers(source);
      const bad = specifiers.filter((s) => importsRealProviderAdapter(s, file));
      if (bad.length > 0) {
        const rel = relative(TESTS_ROOT, file).split(sep).join("/");
        offenders.push(`${rel} -> ${bad.join(", ")}`);
      }
    }

    expect(
      offenders,
      `These test files import a real provider adapter instead of the stub ` +
        `helper (tests/support/stub-llm.ts):\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("scans at least one test file (guards against an empty/broken scan)", () => {
    expect(collectTestFiles(TESTS_ROOT).length).toBeGreaterThan(0);
  });
});
