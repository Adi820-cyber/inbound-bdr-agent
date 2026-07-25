/**
 * Unit tests — `parseInboundEmail` (POST /api/inbound normalization).
 *
 * The parser is the whole compatibility surface of the inbound endpoint, so
 * every wire dialect it promises to accept is asserted here, plus the two rules
 * that make it safe to expose publicly: it never throws, and it never invents a
 * sender or a body.
 */

import { describe, expect, it } from "vitest";

import { parseInboundEmail, parseSender } from "@/agent/inbound-email";

describe("parseInboundEmail — (a) provider JSON", () => {
  it("splits a display-name sender and reads `text` as the body", () => {
    const record = parseInboundEmail({
      contentType: "application/json",
      rawBody: JSON.stringify({
        from: "Ana Ruiz <ana.ruiz@acme-mining.cl>",
        subject: "Drone inspections across 4 sites",
        text: "We run four copper sites and need autonomous inspection.",
      }),
    });

    expect(record).not.toBeNull();
    expect(record!.fromName).toBe("Ana Ruiz");
    expect(record!.fromEmail).toBe("ana.ruiz@acme-mining.cl");
    expect(record!.subject).toBe("Drone inspections across 4 sites");
    expect(record!.body).toBe("We run four copper sites and need autonomous inspection.");
  });

  it("accepts a bare address and a `body` field, leaving the name blank", () => {
    const record = parseInboundEmail({
      contentType: "application/json; charset=utf-8",
      rawBody: JSON.stringify({
        from: "cto@acme.io",
        subject: "Pricing",
        body: "Send pricing for 12 sites.",
      }),
    });

    expect(record).not.toBeNull();
    // A bare address carries no display name; nothing is derived from it.
    expect(record!.fromName).toBe("");
    expect(record!.fromEmail).toBe("cto@acme.io");
    expect(record!.body).toBe("Send pricing for 12 sites.");
  });

  it("preserves unrecognized provider fields in formFields", () => {
    const record = parseInboundEmail({
      contentType: "application/json",
      rawBody: JSON.stringify({
        from: "ops@acme.io",
        subject: "Hello",
        text: "Body here.",
        to: "sales@flytbase.com",
        spam_score: 0.1,
        site_count_answer: "4",
      }),
    });

    expect(record!.formFields).toEqual({
      to: "sales@flytbase.com",
      spam_score: "0.1",
      site_count_answer: "4",
    });
  });
});

describe("parseInboundEmail — (b) already-shaped RawEmailRecord", () => {
  const shaped = {
    fromName: "Rodrigo Castillo",
    fromEmail: "R.Castillo@Example.CL",
    subject: "Autonomous drone program",
    body: "Referred by a partner; Q3 budget conversation.",
  };

  it("reads a `{ rawEmail }` envelope", () => {
    const record = parseInboundEmail({
      contentType: "application/json",
      rawBody: JSON.stringify({ rawEmail: shaped }),
    });

    expect(record).toEqual({
      fromName: "Rodrigo Castillo",
      fromEmail: "r.castillo@example.cl",
      subject: "Autonomous drone program",
      body: "Referred by a partner; Q3 budget conversation.",
    });
  });

  it("reads a bare RawEmailRecord", () => {
    const record = parseInboundEmail({
      contentType: "application/json",
      rawBody: JSON.stringify(shaped),
    });

    expect(record!.fromName).toBe("Rodrigo Castillo");
    expect(record!.fromEmail).toBe("r.castillo@example.cl");
  });

  it("normalizes a supplied receivedAt to ISO-8601", () => {
    const record = parseInboundEmail({
      contentType: "application/json",
      rawBody: JSON.stringify({ ...shaped, receivedAt: "2026-02-01T09:30:00Z" }),
    });

    expect(record!.receivedAt).toBe("2026-02-01T09:30:00.000Z");
  });
});

describe("parseInboundEmail — (c) form-encoded (SendGrid Inbound Parse)", () => {
  it("reads the same field names from a urlencoded body", () => {
    const form = new URLSearchParams({
      from: "Ops Team <ops@acme-mining.cl>",
      subject: "Inspection pilot",
      text: "We want to pilot autonomous inspections at two sites.",
      envelope: '{"to":["sales@flytbase.com"]}',
    });

    const record = parseInboundEmail({
      contentType: "application/x-www-form-urlencoded",
      rawBody: form.toString(),
    });

    expect(record).not.toBeNull();
    expect(record!.fromName).toBe("Ops Team");
    expect(record!.fromEmail).toBe("ops@acme-mining.cl");
    expect(record!.subject).toBe("Inspection pilot");
    expect(record!.body).toBe("We want to pilot autonomous inspections at two sites.");
    expect(record!.formFields).toEqual({ envelope: '{"to":["sales@flytbase.com"]}' });
  });
});

describe("parseInboundEmail — (d) raw RFC822 text/plain", () => {
  it("parses From:/Subject: headers and the body after the first blank line", () => {
    const raw = [
      "Received: by mx.example.com",
      'From: "Ana Ruiz" <ana@acme.io>',
      "To: sales@flytbase.com",
      "Subject: Drone inspection program",
      "Date: Sun, 01 Feb 2026 09:30:00 +0000",
      "",
      "Hi team,",
      "",
      "We operate four sites and need autonomous inspection.",
    ].join("\r\n");

    const record = parseInboundEmail({ contentType: "text/plain", rawBody: raw });

    expect(record).not.toBeNull();
    expect(record!.fromName).toBe("Ana Ruiz");
    expect(record!.fromEmail).toBe("ana@acme.io");
    expect(record!.subject).toBe("Drone inspection program");
    expect(record!.body).toBe(
      "Hi team,\n\nWe operate four sites and need autonomous inspection.",
    );
    expect(record!.receivedAt).toBe("2026-02-01T09:30:00.000Z");
    // Non-sender headers survive as provider extras.
    expect(record!.formFields).toMatchObject({ To: "sales@flytbase.com" });
  });

  it("sniffs raw RFC822 even without a content type", () => {
    const record = parseInboundEmail({
      contentType: null,
      rawBody: "From: cto@acme.io\nSubject: pricing\n\nWe need a demo.",
    });

    expect(record!.fromEmail).toBe("cto@acme.io");
    expect(record!.body).toBe("We need a demo.");
  });
});

describe("parseInboundEmail — null cases (never throws, never invents)", () => {
  it.each([
    ["an empty body", { contentType: "application/json", rawBody: "" }],
    ["whitespace only", { contentType: "text/plain", rawBody: "   \n\n  " }],
    ["malformed JSON with no headers", { contentType: "application/json", rawBody: "{oops" }],
    [
      "JSON with a body but no sender address",
      {
        contentType: "application/json",
        rawBody: JSON.stringify({ subject: "Hi", text: "No sender here." }),
      },
    ],
    [
      "JSON with a sender but no body",
      {
        contentType: "application/json",
        rawBody: JSON.stringify({ from: "a@b.com", subject: "Hi", text: "   " }),
      },
    ],
    [
      "a sender name with no address",
      {
        contentType: "application/json",
        rawBody: JSON.stringify({ from: "Ana Ruiz", text: "Body." }),
      },
    ],
    ["a JSON array", { contentType: "application/json", rawBody: "[1,2,3]" }],
    ["form data with no recognized fields", { contentType: "application/x-www-form-urlencoded", rawBody: "a=1&b=2" }],
  ])("returns null for %s", (_label, input) => {
    expect(parseInboundEmail(input as { contentType: string | null; rawBody: string })).toBeNull();
  });
});

describe("parseSender", () => {
  it.each([
    ['Ana Ruiz <ana@acme.io>', { name: "Ana Ruiz", email: "ana@acme.io" }],
    ['"Ana Ruiz" <ana@acme.io>', { name: "Ana Ruiz", email: "ana@acme.io" }],
    ["<ana@acme.io>", { name: "", email: "ana@acme.io" }],
    ["ana@acme.io", { name: "", email: "ana@acme.io" }],
    ["ANA@ACME.IO", { name: "", email: "ana@acme.io" }],
  ])("parses %s", (input, expected) => {
    expect(parseSender(input)).toEqual(expected);
  });

  it.each(["", "   ", "Ana Ruiz", "not-an-address"])("returns null for %j", (input) => {
    expect(parseSender(input)).toBeNull();
  });
});
