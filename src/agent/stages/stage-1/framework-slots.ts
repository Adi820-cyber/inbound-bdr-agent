/**
 * Stage 1 framework slot tables and the deterministic slot partition (Req 3.4, 3.8).
 *
 * The Qualifier lets the LLM pick a framework and extract `knownFields`, but slot
 * *coverage* is never trusted to the model. Each framework owns a static slot
 * table here, and `partitionSlots` computes `unknownFields = ALL_SLOTS − known`
 * by set difference. Because `unknown` is the exact complement of the (framework-
 * constrained, deduped) `known` set, the union of known and unknown covers every
 * slot of the framework exactly once — Requirement 3.8 holds by construction, not
 * by hope.
 */

import type { FrameworkSlot, QualificationFramework, UnknownField } from "../../contracts";

/** A slot definition carries the label plus the static reason the slot matters. */
export interface FrameworkSlotDef extends FrameworkSlot {
  /** Why leaving this slot unknown is a qualification gap; surfaced in `UnknownField.whyItMatters`. */
  whyItMatters: string;
}

// ---------------------------------------------------------------------------
// Static slot tables (one per framework)
// ---------------------------------------------------------------------------

const MEDDPICC_SLOTS: readonly FrameworkSlotDef[] = [
  {
    slotId: "metrics",
    slotLabel: "Metrics",
    whyItMatters:
      "Quantified impact the buyer expects anchors ROI and separates a nice-to-have from a funded initiative.",
  },
  {
    slotId: "economicBuyer",
    slotLabel: "Economic Buyer",
    whyItMatters:
      "Without the person who controls the budget, a deal cannot be closed no matter how strong the champion.",
  },
  {
    slotId: "decisionCriteria",
    slotLabel: "Decision Criteria",
    whyItMatters:
      "The explicit criteria the buyer will judge vendors against determine how the solution must be positioned.",
  },
  {
    slotId: "decisionProcess",
    slotLabel: "Decision Process",
    whyItMatters:
      "The steps, approvals, and stakeholders in the buying process shape timeline and forecast confidence.",
  },
  {
    slotId: "paperProcess",
    slotLabel: "Paper Process",
    whyItMatters:
      "Procurement, legal, and security review timelines are a common source of slippage if not surfaced early.",
  },
  {
    slotId: "identifiedPain",
    slotLabel: "Identified Pain",
    whyItMatters:
      "A concrete, owned pain is what motivates change; its absence signals a low-urgency exploratory contact.",
  },
  {
    slotId: "champion",
    slotLabel: "Champion",
    whyItMatters:
      "An internal advocate with influence is required to navigate the buying group and sustain momentum.",
  },
  {
    slotId: "competition",
    slotLabel: "Competition",
    whyItMatters:
      "Knowing the alternatives being evaluated, including status quo, guides differentiation and pricing.",
  },
];

const BANT_SLOTS: readonly FrameworkSlotDef[] = [
  {
    slotId: "budget",
    slotLabel: "Budget",
    whyItMatters:
      "A confirmed or estimable budget indicates the initiative is funded rather than aspirational.",
  },
  {
    slotId: "authority",
    slotLabel: "Authority",
    whyItMatters:
      "Identifying who can authorize the purchase prevents investing in a contact who cannot say yes.",
  },
  {
    slotId: "need",
    slotLabel: "Need",
    whyItMatters:
      "A clearly articulated need establishes whether the offering solves a problem the buyer actually has.",
  },
  {
    slotId: "timeline",
    slotLabel: "Timeline",
    whyItMatters:
      "A target decision or deployment date drives prioritization and reveals urgency of the initiative.",
  },
];

const SPICED_SLOTS: readonly FrameworkSlotDef[] = [
  {
    slotId: "situation",
    slotLabel: "Situation",
    whyItMatters:
      "The buyer's current operating context frames what change is realistic and where the solution fits.",
  },
  {
    slotId: "pain",
    slotLabel: "Pain",
    whyItMatters:
      "The specific problem the buyer is trying to solve is the foundation for the entire qualification.",
  },
  {
    slotId: "impact",
    slotLabel: "Impact",
    whyItMatters:
      "The measurable business consequence of the pain justifies investment and sizes the opportunity.",
  },
  {
    slotId: "criticalEvent",
    slotLabel: "Critical Event",
    whyItMatters:
      "A deadline or triggering event creates urgency and gives the deal a compelling reason to act now.",
  },
  {
    slotId: "decision",
    slotLabel: "Decision",
    whyItMatters:
      "Understanding how and by whom the decision is made is required to guide the deal to a close.",
  },
];

/** All framework slot tables, keyed by framework. The single source of truth for slot membership. */
export const FRAMEWORK_SLOTS: Readonly<Record<QualificationFramework, readonly FrameworkSlotDef[]>> = {
  MEDDPICC: MEDDPICC_SLOTS,
  BANT: BANT_SLOTS,
  SPICED: SPICED_SLOTS,
};

// ---------------------------------------------------------------------------
// Slot partition (Req 3.4, 3.8)
// ---------------------------------------------------------------------------

/** The result of partitioning a framework's slots against a set of known slot ids. */
export interface SlotPartition {
  framework: QualificationFramework;
  /** The complete slot set of the framework, in canonical table order. */
  frameworkSlots: FrameworkSlot[];
  /** Known slot ids that belong to the framework, deduped, in canonical table order. */
  knownSlotIds: string[];
  /** Every framework slot not present in `knownSlotIds`, in canonical table order. */
  unknownFields: UnknownField[];
}

/**
 * Pure partition of a framework's slots into known and unknown.
 *
 * `unknownFields = ALL_SLOTS − known`, computed by set difference. Input slot ids
 * are deduped and any id not belonging to the framework is discarded, so the
 * union of `knownSlotIds` and `unknownFields` covers every framework slot exactly
 * once regardless of what the caller supplied (Req 3.4, 3.8).
 */
export function partitionSlots(
  framework: QualificationFramework,
  knownSlotIds: readonly string[],
): SlotPartition {
  const slots = FRAMEWORK_SLOTS[framework];
  const validIds = new Set(slots.map((slot) => slot.slotId));

  // Discard ids not belonging to the framework and dedupe.
  const known = new Set<string>();
  for (const id of knownSlotIds) {
    if (validIds.has(id)) {
      known.add(id);
    }
  }

  // Emit in canonical table order so known ⊎ unknown is a deterministic partition.
  const frameworkSlots: FrameworkSlot[] = [];
  const resolvedKnownIds: string[] = [];
  const unknownFields: UnknownField[] = [];

  for (const slot of slots) {
    frameworkSlots.push({ slotId: slot.slotId, slotLabel: slot.slotLabel });
    if (known.has(slot.slotId)) {
      resolvedKnownIds.push(slot.slotId);
    } else {
      unknownFields.push({
        slotId: slot.slotId,
        slotLabel: slot.slotLabel,
        whyItMatters: slot.whyItMatters,
      });
    }
  }

  return {
    framework,
    frameworkSlots,
    knownSlotIds: resolvedKnownIds,
    unknownFields,
  };
}
