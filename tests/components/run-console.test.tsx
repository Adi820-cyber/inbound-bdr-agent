// @vitest-environment jsdom
import React from "react";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import Home from "@/app/page";

describe("Run Console UI Component Tests", () => {
  it("renders 6 stage panels and the pipeline trigger button", () => {
    render(<Home />);

    expect(screen.getByText(/FlytBase Inbound BDR Agent/i)).toBeDefined();
    expect(screen.getByText(/Run Agent Pipeline/i)).toBeDefined();

    expect(screen.getByText(/Qualification & Fit Assessment/i)).toBeDefined();
    expect(screen.getByText(/Account Research & Provenance/i)).toBeDefined();
    expect(screen.getByText(/Adaptive Response Sequence/i)).toBeDefined();
    expect(screen.getByText(/Attribute-Driven Case Study Match/i)).toBeDefined();
    expect(screen.getByText(/GTM Motion & Partner Strategy/i)).toBeDefined();
    expect(screen.getByText(/AE Handoff Summary/i)).toBeDefined();
  });
});
