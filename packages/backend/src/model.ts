import type { Call, Load } from "@voice-freight/contracts/calls";
import type { ToolResult } from "./business";
import type { EvidenceInput, Identity } from "@voice-freight/contracts/business";

export type Verification = {
  carrierId: string | null;
  mcNumber: string;
  name: string | null;
  status: "eligible" | "ineligible" | "not_found" | "unavailable";
  reason: string;
  source: "fixture";
  fixtureVersion: string;
  evidence: {
    authority: boolean | null;
    permission: boolean | null;
    outOfService: boolean | null;
    contradictory: boolean;
  } | null;
  verifiedAt: string;
};

export type CallRecord = {
  id: string;
  ownerId: string;
  inventoryIds: string[];
  verification: Verification | null;
  selectedLoadId: string | null;
  quoteId: string | null;
  record: Call;
  finalSnapshot: Call | null;
};

export type Inventory = {
  id: string;
  batchId: string;
  maximumCents: number;
  load: Load;
};

export type Negotiation = {
  id: string;
  carrierId: string;
  loadId: string;
  policyVersion: string;
  version: number;
  rateCents: number;
  prices: number[];
};

export type Quote = {
  evidenceAfterMs?: number;
  id: string;
  callId: string;
  carrierId: string;
  loadId: string;
  pairVersion: number;
  version: number;
  rateCents: number;
  replacementId: string | null;
  valid: boolean;
};

export type Agreement = {
  evidenceAfterMs?: number;
  id: string;
  callId: string;
  ownerId: string;
  carrierId: string;
  verification: Verification;
  load: Load;
  rateCents: number;
  version: number;
  status: "effective" | "cancelled" | "superseded";
  evidence: { readbackId: string; callerId: string };
  cancellationEvidence?: { readbackId: string; callerId: string };
};

export type Evidence = EvidenceInput & {
  callId: string;
  contextVersion: string;
  carrierId: string;
  loadId: string;
  rateCents: number;
  recordedAt: string;
};

export type ReceiptOutcome = { result: ToolResult } | { error: Pick<BusinessError, "code" | "message" | "status"> };

export type Receipt = {
  id: string;
  callId: string;
  fingerprint: string;
} & ReceiptOutcome;

export type NegotiationEvent = {
  id: string;
  callId: string;
  pairId: string;
  amountCents: number;
  consumed: boolean;
  decision: string;
  quoteId: string;
};

export type Analysis = {
  id: string;
  callId: string;
  version: number;
  status: "pending";
  publication: "pending";
  attempts: number;
  createdAt: string;
};

export type Session = { id: string; userId: string; expiresAt: string };

export type State = {
  spendingPeriods: SpendingPeriod[];
  reservations: Reservation[];
  providerUsage: ProviderUsage[];
  liveSessions: LiveSession[];
  transcriptFragments: TranscriptFragment[];
  users: Identity[];
  sessions: Session[];
  calls: CallRecord[];
  inventory: Inventory[];
  negotiations: Negotiation[];
  quotes: Quote[];
  agreements: Agreement[];
  evidence: Evidence[];
  receipts: Receipt[];
  events: NegotiationEvent[];
  analysis: Analysis[];
};

export type SpendingPeriod = {
  id: string;
  spentMicrodollars: number;
};

export type Reservation = {
  id: string;
  ownerId: string;
  operationId: string;
  createdAt: string;
  reservedMicrodollars: number;
  chargedMicrodollars: number;
  settled: boolean;
  prices: ModelPrices;
};

export type ModelPrices = {
  version: string;
  voiceMicrodollarsPerMinute: number;
  inputMicrodollarsPerMillionTokens: number;
  cachedInputMicrodollarsPerMillionTokens: number;
  outputMicrodollarsPerMillionTokens: number;
};

export type ProviderUsage = {
  id: string;
  callId: string;
  periodId: string;
  costMicrodollars: number;
};

export type LiveSession = {
  farewell?: { deadline: string; delegationId: string };
  closingAt: string | null;
  maximumCallSeconds: number;
  inactivitySeconds: number;
  id: string;
  providerId: string | null;
  state: "connecting" | "connected" | "ending" | "ended";
  notice: string | null;
  providerAttempted: boolean;
  providerClosed: boolean;
  usageConfirmed: boolean;
  voiceSeconds: number;
  lastInputAt: string;
  warned: boolean;
  gap: boolean;
  responseIds: string[];
  completedResponseIds: string[];
  continuations: Record<string, number>;
  processedEventIds: string[];
  submittedCallIds: string[];
  delegationCallIds: Record<string, string[]>;
  answerSdp: string | null;
};

export type TranscriptFragment = {
  sequence: number;
  id: string;
  callId: string;
  speaker: "carrier" | "broker";
  startMs: number;
  endMs: number;
  text: string;
};

export class BusinessError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: 400 | 401 | 403 | 404 | 409 | 503 = 409,
  ) {
    super(message);
  }
}

export function requireCondition(
  condition: unknown,
  code: string,
  message: string,
  status: 400 | 401 | 403 | 404 | 409 | 503 = 409,
): asserts condition {
  if (!condition) {
    throw new BusinessError(code, message, status);
  }
}
