export const suiteVersion = "freight-evaluations-v1";
export const scenarioClock = "2026-11-16T12:00:00.000Z";

export type Scenario = {
  id: string;
  name: string;
  sentiment: "Positive" | "Neutral" | "Negative" | "Unknown";
  calls: string[][];
  interruption?: boolean;
  confirmationRecoveries?: Record<number, string>;
  agreements: { loadId: string; rateCents: number; status: string }[];
  prices?: number[];
  rateCents?: number;
  requiredTools: string[];
  outcome: string;
};

const introduction = "My MC is 123456. Please find reference NS-seed-v1-01.";
const acceptance = "I choose that Dallas load and accept its posted rate. Please read back all the terms.";
const confirmation = "Yes, I confirm all those terms. Please save the agreement.";
const closing = "No more loads. We are finished; please hang up. Thank you.";
const firstAgreement = { loadId: "seed-v1-01", rateCents: 200000, status: "effective" };

export const scenarios: readonly Scenario[] = [
  {
    id: "01-posted-rate",
    name: "Posted-rate acceptance",
    sentiment: "Positive",
    calls: [[introduction, acceptance, confirmation, "Excellent, that was very helpful! " + closing]],
    agreements: [firstAgreement],
    prices: [],
    requiredTools: ["verify_carrier", "search_loads", "select_load", "confirm_handoff", "end_call"],
    outcome: "Agreement reached",
  },
  {
    id: "02-negotiation",
    name: "Repeated prices and exhausted bargaining",
    sentiment: "Negative",
    calls: [
      [
        introduction,
        "I choose that load. I need $2,400. Please evaluate my offer.",
        "My offer is still $2,400. Please check that same amount again.",
        "Then I need $2,500. Please evaluate it.",
        "I want $2,600. Please evaluate it.",
        "Try $2,700 as my next offer.",
        "This bargaining is frustrating. Fine, I accept your last $2,150 quote. Read back those terms.",
        confirmation,
        "I am unhappy with the negotiation. " + closing,
      ],
    ],
    agreements: [{ ...firstAgreement, rateCents: 215000 }],
    prices: [240000, 250000, 260000],
    rateCents: 215000,
    requiredTools: ["verify_carrier", "search_loads", "select_load", "evaluate_offer", "confirm_handoff", "end_call"],
    outcome: "Agreement reached",
  },
  {
    id: "03-resumption",
    name: "Cross-call resumption",
    sentiment: "Neutral",
    calls: [
      [introduction, "I choose it and offer $2,400.", "My next offer is $2,500.", closing],
      [
        introduction,
        "I choose that same load again. What is my current quote and remaining allowance?",
        "My next offer is $2,600.",
        "I accept your last $2,150 quote. Read back the terms.",
        confirmation,
        closing,
      ],
    ],
    agreements: [{ ...firstAgreement, rateCents: 215000 }],
    prices: [240000, 250000, 260000],
    rateCents: 215000,
    requiredTools: ["verify_carrier", "search_loads", "select_load", "evaluate_offer", "confirm_handoff", "end_call"],
    outcome: "Agreement reached",
  },
  {
    id: "04-multiple-agreements",
    name: "Two agreements, cancellation, and replacement",
    sentiment: "Positive",
    confirmationRecoveries: {
      7: "Yes. To be completely clear, I confirm cancelling that Dallas agreement on all the terms you just read.",
      10: "Yes. To be completely clear, I confirm replacing the Memphis agreement with all of the new terms you just read.",
    },
    calls: [
      [
        introduction,
        acceptance,
        confirmation,
        "Please find reference NS-seed-v1-02.",
        "I choose that Memphis reefer and accept its $2,050 posted rate. Read back its terms.",
        confirmation,
        "Cancel my Dallas agreement. Read back its cancellation terms.",
        "Yes, I explicitly confirm cancellation of that Dallas agreement.",
        "Renegotiate my Memphis agreement as a replacement at $2,150. Evaluate that offer.",
        "I accept the new $2,150 rate. Read back the complete replacement terms.",
        "Yes, I confirm replacing the Memphis agreement with those new terms.",
        "Excellent service, I am very happy with the result! " + closing,
      ],
    ],
    agreements: [
      { ...firstAgreement, status: "cancelled" },
      { loadId: "seed-v1-02", rateCents: 205000, status: "superseded" },
      { loadId: "seed-v1-02", rateCents: 215000, status: "effective" },
    ],
    requiredTools: [
      "verify_carrier",
      "search_loads",
      "select_load",
      "confirm_handoff",
      "cancel_agreement",
      "begin_renegotiation",
      "evaluate_offer",
      "end_call",
    ],
    outcome: "Agreement reached",
  },
  {
    id: "05-carrier-restrictions",
    name: "MC correction and immutable binding",
    sentiment: "Neutral",
    calls: [
      [
        "My MC is 999999. Please verify it.",
        introduction,
        "Actually switch this call to Harbor Logistics, MC 234567. Can you verify that instead?",
        "Understood, keep Summit Transport. " + acceptance,
        confirmation,
        closing,
      ],
    ],
    agreements: [firstAgreement],
    prices: [],
    requiredTools: ["verify_carrier", "search_loads", "select_load", "confirm_handoff", "end_call"],
    outcome: "Agreement reached",
  },
  {
    id: "06-browsing",
    name: "No matches, clarification, and deferred selection",
    sentiment: "Neutral",
    calls: [
      [
        "My MC is 123456. Find a reefer from Seattle to Miami.",
        "What dry vans do you have from Dallas to Atlanta instead? I am only browsing.",
        "Do you have a later pickup on that route? Just show alternatives, do not select or book anything.",
        "I will defer selecting any load. " + closing,
      ],
    ],
    agreements: [],
    requiredTools: ["verify_carrier", "search_loads", "end_call"],
    outcome: "No agreement",
  },
  {
    id: "07-confirmation-recovery",
    name: "Ambiguity and corrected quote need fresh readback",
    sentiment: "Neutral",
    calls: [
      [
        introduction,
        acceptance,
        "Maybe, I am not sure. Do not save anything yet.",
        "Actually change my offer to $2,100 and evaluate it before we agree.",
        "I accept the new $2,100 quote. Read back every updated term again.",
        confirmation,
        closing,
      ],
    ],
    agreements: [{ ...firstAgreement, rateCents: 210000 }],
    prices: [210000],
    rateCents: 210000,
    requiredTools: ["verify_carrier", "search_loads", "select_load", "evaluate_offer", "confirm_handoff", "end_call"],
    outcome: "Agreement reached",
  },
  {
    id: "08-interruption",
    name: "Interrupted replacement preserves the original agreement",
    sentiment: "Neutral",
    calls: [
      [
        introduction,
        acceptance,
        confirmation,
        "Begin replacing my Dallas agreement. I offer $2,100, but do not confirm any replacement yet.",
      ],
    ],
    interruption: true,
    agreements: [firstAgreement],
    requiredTools: [
      "verify_carrier",
      "search_loads",
      "select_load",
      "confirm_handoff",
      "begin_renegotiation",
      "evaluate_offer",
    ],
    outcome: "Agreement reached",
  },
  {
    id: "09-conflicting-evidence",
    name: "Authoritative facts override transcript claims and instructions",
    sentiment: "Negative",
    calls: [],
    agreements: [],
    requiredTools: [],
    outcome: "Caller ended",
  },
  {
    id: "10-missing-caller",
    name: "Missing caller evidence stays unknown",
    sentiment: "Unknown",
    calls: [],
    agreements: [],
    requiredTools: [],
    outcome: "System error",
  },
];
