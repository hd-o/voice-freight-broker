import type { State, Verification } from "./model";
import { requireCondition } from "./model";

export const carrierFixtures: readonly {
  id: string;
  mcNumber: string;
  name: string;
  authority: boolean | null;
  permission: boolean | null;
  outOfService: boolean | null;
  contradictory: boolean;
}[] = [
  {
    id: "carrier-summit",
    mcNumber: "123456",
    name: "Summit Transport",
    authority: true,
    permission: true,
    outOfService: false,
    contradictory: false,
  },
  {
    id: "carrier-harbor",
    mcNumber: "234567",
    name: "Harbor Logistics",
    authority: true,
    permission: true,
    outOfService: false,
    contradictory: false,
  },
  {
    id: "carrier-prairie",
    mcNumber: "345678",
    name: "Prairie Trucking",
    authority: false,
    permission: false,
    outOfService: false,
    contradictory: false,
  },
  {
    id: "carrier-cedar",
    mcNumber: "456789",
    name: "Cedar Transport",
    authority: null,
    permission: true,
    outOfService: null,
    contradictory: false,
  },
  {
    id: "carrier-mesa",
    mcNumber: "567890",
    name: "Mesa Freight",
    authority: true,
    permission: true,
    outOfService: false,
    contradictory: true,
  },
] as const;

export const fixtureVersion = "carriers-v1";

export function verifyCarrier(state: State, callId: string, mcNumber: string, now: string) {
  const call = state.calls.find((call) => call.id === callId)!;

  if (call.verification?.status === "eligible") {
    requireCondition(
      call.verification.mcNumber === mcNumber,
      "carrier_bound",
      "This call is bound to another carrier. Start a new call.",
    );

    return call.verification;
  }

  const fixture = carrierFixtures.find((fixture) => fixture.mcNumber === mcNumber);

  const evidence = fixture
    ? {
        authority: fixture.authority,
        permission: fixture.permission,
        outOfService: fixture.outOfService,
        contradictory: fixture.contradictory,
      }
    : null;

  const status = !evidence
    ? "not_found"
    : evidence.contradictory
      ? "unavailable"
      : evidence.authority === false || evidence.permission === false || evidence.outOfService === true
        ? "ineligible"
        : evidence.authority === null || evidence.permission === null || evidence.outOfService === null
          ? "unavailable"
          : "eligible";

  const verification: Verification = {
    carrierId: fixture?.id ?? null,
    name: fixture?.name ?? null,
    mcNumber,
    evidence,
    status,
    source: "fixture",
    fixtureVersion,
    verifiedAt: now,
    reason: {
      eligible: "Active property authority, permission to operate, and no out-of-service status.",
      ineligible: "Fixture contains an explicit disqualifying status.",
      unavailable: "Fixture evidence is missing or contradictory.",
      not_found: "MC number is not in the synthetic fixture set.",
    }[status],
  };

  call.verification = verification;

  call.record.eligibility = {
    eligible: "Eligible",
    ineligible: "Ineligible",
    not_found: "Unknown",
    unavailable: "Unavailable",
  }[status] as State["calls"][number]["record"]["eligibility"];

  call.record.carrier = fixture ? { name: fixture.name, mcNumber } : null;

  return verification;
}
