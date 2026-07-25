/**
 * Stage 3 — Responder: unknown-slot coverage planner.
 *
 * A PURE, deterministic function that partitions the qualification result's
 * `unknownFields` across the three email drafts, assigning 1–2 slots to each
 * email. It greedily prioritizes the high-information slots (economic buyer,
 * decision process, metrics) and guarantees that the three emails together
 * cover >= 3 distinct unknown slots whenever >= 3 distinct slots are available
 * (Req 6.3, 6.4).
 *
 * Determinism here means the coverage requirement is met by arithmetic, not by
 * asking the model nicely: the same `unknownFields` input always yields the
 * same assignment.
 */

import type { UnknownField } from "../../contracts";

/** Per-email slot assignment. `targetedUnknownSlotIds` has length 1..2 (Req 6.3). */
export interface EmailSlotAssignment {
  position: 1 | 2 | 3;
  targetedUnknownSlotIds: string[];
}

/** The deterministic plan the responder feeds into its generation call. */
export interface SlotPlan {
  assignments: [EmailSlotAssignment, EmailSlotAssignment, EmailSlotAssignment];
  /** Distinct union of every targeted slot id; >= 3 when >= 3 were available (Req 6.4). */
  coveredUnknownSlotIds: string[];
}

/**
 * High-information slots, in priority order (Req 6.3). Matching is done on a
 * normalized form so this works whether a framework exposes the slot as an id
 * (`economicBuyer`) or a label (`Economic Buyer`).
 */
const PRIORITY_SLOT_KEYS: readonly string[] = ["economicbuyer", "decisionprocess", "metrics"] as const;

/**
 * Fallback slot set used only when the qualification result carries no unknown
 * fields at all (e.g. Stage 3 running without a qualification result). Keeps the
 * per-email 1..2 contract satisfiable and preserves the >= 3 distinct guarantee.
 */
const DEFAULT_UNKNOWN_SLOT_IDS: readonly string[] = [
  "economicBuyer",
  "decisionProcess",
  "metrics",
] as const;

/** Lowercase and strip non-alphanumerics so `Economic Buyer` and `economicBuyer` collide. */
function normalizeKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Priority rank: lower is higher priority; non-priority slots share the sentinel rank. */
function priorityRank(field: { slotId: string; slotLabel: string }): number {
  const idKey = normalizeKey(field.slotId);
  const labelKey = normalizeKey(field.slotLabel);
  for (let i = 0; i < PRIORITY_SLOT_KEYS.length; i++) {
    if (idKey === PRIORITY_SLOT_KEYS[i] || labelKey === PRIORITY_SLOT_KEYS[i]) {
      return i;
    }
  }
  return PRIORITY_SLOT_KEYS.length;
}

/**
 * Order the distinct unknown slots high-information-first, preserving the input
 * order among equally ranked slots (a stable sort keeps the function total and
 * deterministic).
 */
function orderSlots(unknownFields: readonly UnknownField[]): string[] {
  const seen = new Set<string>();
  const distinct: { slotId: string; slotLabel: string; index: number }[] = [];
  for (const field of unknownFields) {
    if (typeof field?.slotId !== "string" || field.slotId.length === 0) continue;
    if (seen.has(field.slotId)) continue;
    seen.add(field.slotId);
    distinct.push({ slotId: field.slotId, slotLabel: field.slotLabel ?? "", index: distinct.length });
  }

  return distinct
    .map((slot) => ({ slot, rank: priorityRank(slot) }))
    .sort((a, b) => (a.rank !== b.rank ? a.rank - b.rank : a.slot.index - b.slot.index))
    .map((entry) => entry.slot.slotId);
}

/**
 * Deterministically partition `unknownFields` across the three email drafts.
 *
 * - Each email receives 1..2 slot ids (Req 6.3).
 * - When >= 3 distinct slots are available, the sequence covers >= 3 distinct
 *   slots (Req 6.4): the first distributive pass places one distinct slot on
 *   each of the three emails before any email receives a second.
 * - High-information slots (economic buyer, decision process, metrics) are
 *   placed first (Req 6.3).
 * - With fewer than three distinct slots available, slots are reused so every
 *   email still carries at least one target; distinct coverage is then simply
 *   the number of slots that existed.
 */
export function planUnknownSlots(unknownFields: readonly UnknownField[]): SlotPlan {
  let slots = orderSlots(unknownFields ?? []);
  if (slots.length === 0) {
    slots = [...DEFAULT_UNKNOWN_SLOT_IDS];
  }

  const perEmail: [string[], string[], string[]] = [[], [], []];

  // Column-major distribution: round 0 gives each email one distinct slot
  // (guaranteeing >= 3 distinct coverage when >= 3 exist), round 1 tops each
  // email up to at most two. Slots beyond the sixth are dropped.
  let idx = 0;
  for (let round = 0; round < 2; round++) {
    for (const email of perEmail) {
      const slot = slots[idx];
      if (slot !== undefined && email.length < 2) {
        email.push(slot);
        idx++;
      }
    }
  }

  // Fewer than three distinct slots: reuse in priority order so no email is
  // left empty (the per-email length-1 minimum always holds).
  perEmail.forEach((email, position) => {
    if (email.length === 0) {
      const slot = slots[position % slots.length];
      if (slot !== undefined) email.push(slot);
    }
  });

  const covered: string[] = [];
  const coveredSeen = new Set<string>();
  for (const email of perEmail) {
    for (const slotId of email) {
      if (!coveredSeen.has(slotId)) {
        coveredSeen.add(slotId);
        covered.push(slotId);
      }
    }
  }

  return {
    assignments: [
      { position: 1, targetedUnknownSlotIds: perEmail[0] },
      { position: 2, targetedUnknownSlotIds: perEmail[1] },
      { position: 3, targetedUnknownSlotIds: perEmail[2] },
    ],
    coveredUnknownSlotIds: covered,
  };
}
