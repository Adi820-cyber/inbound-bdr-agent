/**
 * Property 4 — Framework slot coverage is an exact partition.
 *
 * **Validates: Requirements 3.4, 3.8**
 *
 * Slot coverage is never trusted to the model. For any framework
 * (MEDDPICC/BANT/SPICED) and any set of candidate "known" slot ids —
 * duplicates, ids belonging to other frameworks, and pure garbage strings
 * included — `partitionSlots(framework, knownSlotIds)` computes
 * `unknownFields = ALL_SLOTS − known` by set difference. This suite asserts the
 * partition is exact:
 *
 *   - `frameworkSlots` is the framework's complete slot table in canonical
 *     order.
 *   - `knownSlotIds` and `unknownFields` are each duplicate-free and disjoint.
 *   - Their union covers every framework slot exactly once (no dupes, no
 *     extras).
 *   - Only ids that actually belong to the framework survive; any supplied id
 *     outside the framework is discarded.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import type { QualificationFramework } from "@/agent/contracts";
import {
  FRAMEWORK_SLOTS,
  partitionSlots,
} from "@/agent/stages/stage-1/framework-slots";

import { arbEdgeString } from "./arbitraries";

const FRAMEWORKS: readonly QualificationFramework[] = ["MEDDPICC", "BANT", "SPICED"];

const arbFramework: fc.Arbitrary<QualificationFramework> = fc.constantFrom(
  ...FRAMEWORKS,
);

/** Every slot id across all three frameworks — used to inject cross-framework noise. */
const ALL_SLOT_IDS: readonly string[] = FRAMEWORKS.flatMap((f) =>
  FRAMEWORK_SLOTS[f].map((s) => s.slotId),
);

/**
 * Candidate known-slot-id lists: a mix of real framework ids (from any
 * framework), arbitrary strings, and edge-case strings, with duplicates
 * possible.
 */
const arbKnownSlotIds: fc.Arbitrary<string[]> = fc.array(
  fc.oneof(
    fc.constantFrom(...ALL_SLOT_IDS),
    fc.string(),
    arbEdgeString,
  ),
  { maxLength: 24 },
);

describe("Property 4: framework slot coverage is an exact partition (Req 3.4, 3.8)", () => {
  it("frameworkSlots equals the framework's complete slot table in canonical order", () => {
    fc.assert(
      fc.property(arbFramework, arbKnownSlotIds, (framework, knownSlotIds) => {
        const canonicalIds = FRAMEWORK_SLOTS[framework].map((s) => s.slotId);
        const partition = partitionSlots(framework, knownSlotIds);
        expect(partition.frameworkSlots.map((s) => s.slotId)).toEqual(canonicalIds);
      }),
    );
  });

  it("known and unknown are duplicate-free, disjoint, and cover every slot exactly once", () => {
    fc.assert(
      fc.property(arbFramework, arbKnownSlotIds, (framework, knownSlotIds) => {
        const canonicalIds = FRAMEWORK_SLOTS[framework].map((s) => s.slotId);
        const partition = partitionSlots(framework, knownSlotIds);

        const knownIds = partition.knownSlotIds;
        const unknownIds = partition.unknownFields.map((u) => u.slotId);

        // No dupes within either side.
        expect(new Set(knownIds).size).toBe(knownIds.length);
        expect(new Set(unknownIds).size).toBe(unknownIds.length);

        // Disjoint.
        for (const id of knownIds) expect(unknownIds).not.toContain(id);

        // Union covers every framework slot exactly once (no dupes, no extras).
        expect([...knownIds, ...unknownIds].sort()).toEqual([...canonicalIds].sort());
      }),
    );
  });

  it("known is exactly the supplied framework ids (deduped, canonical order); unknown is its complement", () => {
    fc.assert(
      fc.property(arbFramework, arbKnownSlotIds, (framework, knownSlotIds) => {
        const canonicalIds = FRAMEWORK_SLOTS[framework].map((s) => s.slotId);
        const partition = partitionSlots(framework, knownSlotIds);

        const suppliedSet = new Set(knownSlotIds);
        const expectedKnown = canonicalIds.filter((id) => suppliedSet.has(id));
        const expectedUnknown = canonicalIds.filter((id) => !suppliedSet.has(id));

        expect(partition.knownSlotIds).toEqual(expectedKnown);
        expect(partition.unknownFields.map((u) => u.slotId)).toEqual(expectedUnknown);
      }),
    );
  });

  it("discards ids that do not belong to the framework", () => {
    fc.assert(
      fc.property(arbFramework, arbKnownSlotIds, (framework, knownSlotIds) => {
        const validSet = new Set(FRAMEWORK_SLOTS[framework].map((s) => s.slotId));
        const partition = partitionSlots(framework, knownSlotIds);

        // Nothing outside the framework's slot set leaks into either bucket.
        for (const id of partition.knownSlotIds) expect(validSet.has(id)).toBe(true);
        for (const u of partition.unknownFields) expect(validSet.has(u.slotId)).toBe(true);

        // Any supplied id not in the framework is absent from known.
        for (const id of knownSlotIds) {
          if (!validSet.has(id)) expect(partition.knownSlotIds).not.toContain(id);
        }
      }),
    );
  });
});
