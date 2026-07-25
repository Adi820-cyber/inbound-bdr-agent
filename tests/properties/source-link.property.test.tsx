// @vitest-environment jsdom
import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { SourceLink } from "@/components/SourceLink";

describe("Property 15: Source URLs render as resolvable links", () => {
  it("renders a valid anchor tag for verified URLs", () => {
    const testUrl = "https://flytbase.com/case-studies/mining-automation";
    const { container } = render(<SourceLink url={testUrl} status="verified" />);

    const anchor = container.querySelector("a");
    expect(anchor).not.toBeNull();
    expect(anchor?.getAttribute("href")).toBe(testUrl);
    expect(anchor?.getAttribute("target")).toBe("_blank");
  });

  it("renders unverified notice when URL is unknown", () => {
    const { container } = render(<SourceLink url="unknown" status="unknown" />);
    expect(container.textContent).toContain("Unverified / Unknown Source");
  });
});
