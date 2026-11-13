import type { Call, Load } from "@voice-freight/contracts/calls";
import type { ToolResult } from "./business";
import type {
  EvidenceInput,
  Identity,
} from "@voice-freight/contracts/business";

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
export type ReceiptOutcome =
  | { result: ToolResult }
  | { error: Pick<BusinessError, "code" | "message" | "status"> };
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
  if (!condition) throw new BusinessError(code, message, status);
}
