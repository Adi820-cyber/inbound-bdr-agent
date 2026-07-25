// @vitest-environment jsdom
import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { Stage3View } from "@/components/stage-views/Stage3View";
import type { EmailSequence } from "@/agent/contracts";

describe("Property 30: Reasoning artifacts render as visible text", () => {
  it("renders progression rationale for email drafts 2 and 3 as visible text", () => {
    const mockOutput: EmailSequence = {
      emails: [
        {
          position: 1,
          subject: "Subject 1",
          body: "Body 1",
          referencedClaimIds: ["claim_1"],
          targetedUnknownSlotIds: ["slot_1"],
          sendTimingGuidance: "Day 0",
          progressionRationale: "unknown",
        },
        {
          position: 2,
          subject: "Subject 2",
          body: "Body 2",
          referencedClaimIds: ["claim_2"],
          targetedUnknownSlotIds: ["slot_2"],
          sendTimingGuidance: "Day 3",
          progressionRationale: "Visible Rationale text for email 2",
        },
        {
          position: 3,
          subject: "Subject 3",
          body: "Body 3",
          referencedClaimIds: ["claim_3"],
          targetedUnknownSlotIds: ["slot_3"],
          sendTimingGuidance: "Day 7",
          progressionRationale: "Visible Rationale text for email 3",
        },
      ],
      coveredUnknownSlotIds: ["slot_1", "slot_2", "slot_3"],
      personaAdaptationNote: "Operations adaptation note",
      researchUnavailableNotice: "unknown",
    };

    const { container } = render(<Stage3View output={mockOutput} />);

    expect(container.textContent).toContain("Visible Rationale text for email 2");
    expect(container.textContent).toContain("Visible Rationale text for email 3");
    expect(container.textContent).toContain("Operations adaptation note");
  });
});
