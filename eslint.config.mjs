import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({ baseDirectory: __dirname });

const eslintConfig = [
  {
    ignores: [
      ".next/**",
      "node_modules/**",
      ".data/**",
      "next-env.d.ts",
    ],
  },
  ...compat.extends("next/core-web-vitals", "next/typescript"),

  // -------------------------------------------------------------------------
  // Web-egress confinement (Req 13.4)
  //
  // All third-party web access must flow through the Research Toolbelt
  // (`src/research/**`) and the provider adapters (`src/providers/**`), so that
  // every outbound request is timed, capped, and recorded in the fetch ledger.
  // Everything else — the orchestrator, the six stages, the shared libs — is
  // banned from raw egress: no `fetch`, no `axios`, no `undici`, no
  // `node:http`/`node:https`.
  // -------------------------------------------------------------------------
  {
    files: ["**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}"],
    rules: {
      "no-restricted-globals": [
        "error",
        {
          name: "fetch",
          message:
            "Raw web egress is confined to the Research Toolbelt (src/research/**) and provider adapters (src/providers/**) (Req 13.4).",
        },
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector: 'CallExpression[callee.name="fetch"]',
          message:
            "Raw web egress is confined to the Research Toolbelt (src/research/**) and provider adapters (src/providers/**) (Req 13.4).",
        },
        {
          selector:
            'MemberExpression[object.name=/^(globalThis|window|global)$/][property.name="fetch"]',
          message:
            "Raw web egress is confined to the Research Toolbelt (src/research/**) and provider adapters (src/providers/**) (Req 13.4).",
        },
      ],
      "no-restricted-imports": [
        "error",
        {
          paths: [
            "axios",
            "undici",
            "node-fetch",
            "got",
            "superagent",
            "request",
            "node:http",
            "node:https",
            "http",
            "https",
          ].map((name) => ({
            name,
            message:
              "HTTP clients are confined to the Research Toolbelt (src/research/**) and provider adapters (src/providers/**) (Req 13.4).",
          })),
          patterns: [
            {
              group: ["axios/*", "undici/*"],
              message:
                "HTTP clients are confined to the Research Toolbelt (src/research/**) and provider adapters (src/providers/**) (Req 13.4).",
            },
          ],
        },
      ],
    },
  },

  // The two directories that own web egress: the Research Toolbelt performs the
  // page fetches and the provider adapters call the LLM and search APIs.
  {
    files: ["src/research/**", "src/providers/**"],
    rules: {
      "no-restricted-globals": "off",
      "no-restricted-syntax": "off",
      "no-restricted-imports": "off",
    },
  },

  // Client-side app code: `fetch` here is same-origin traffic to our OWN
  // `/api/run` and `/api/runs/:runId` endpoints from the browser, not
  // third-party web egress, so the `fetch` ban does not apply. The
  // `no-restricted-imports` ban on axios/undici/node:http stays in force here —
  // reaching a third-party HTTP client from the UI is still forbidden.
  {
    files: ["src/app/**", "src/components/**", "src/hooks/**"],
    rules: {
      "no-restricted-globals": "off",
      "no-restricted-syntax": "off",
    },
  },

  // Tests stub and assert on `fetch` itself (the no-live-calls guard and the
  // fetch-ledger properties), so they need to name it directly.
  {
    files: ["tests/**"],
    rules: {
      "no-restricted-globals": "off",
      "no-restricted-syntax": "off",
      "no-restricted-imports": "off",
    },
  },
];

export default eslintConfig;
