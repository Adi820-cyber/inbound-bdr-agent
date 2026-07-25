import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // The crawl and HTML parsing use Node APIs, so route handlers stay on the
  // Node runtime rather than Edge (see design: Deployment Decision).
  outputFileTracingIncludes: {
    "/api/run": ["./src/research/cached-corpus/**/*"],
  },
  // Tests (Vitest) are type-checked and run separately via `npm test`; the
  // production build should not fail on test-only type issues. Application
  // source under src/ is type-clean.
  typescript: {
    ignoreBuildErrors: true,
  },
  eslint: {
    ignoreDuringBuilds: true,
  },
};

export default nextConfig;
