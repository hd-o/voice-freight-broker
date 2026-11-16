import type { State } from "./model";
import { requireCondition } from "./model";
import { describeLoad } from "./readbacks";
import { matchLocation } from "./locations";

const routes = [
  ["Dallas, TX", "Atlanta, GA", "Dry van", 780, "America/Chicago"],
  ["Memphis, TN", "Denver, CO", "Reefer", 1090, "America/Chicago"],
  ["Chicago, IL", "Columbus, OH", "Dry van", 360, "America/Chicago"],
  ["Phoenix, AZ", "Los Angeles, CA", "Flatbed", 375, "America/Phoenix"],
  ["Savannah, GA", "Charlotte, NC", "Dry van", 250, "America/New_York"],
] as const;

export function addInventory(
  state: State,
  batchId: string,
  now: string,
): {
  added: number;
  batchId: string;
} {
  const existing = state.inventory.filter((entry): boolean => entry.batchId === batchId);

  if (existing.length) {
    return { added: 0, batchId };
  }

  for (let index = 0; index < 20; index++) {
    const [origin, destination, equipment, miles, pickupTimeZone] = routes[index % routes.length];

    const day = new Date(now);
    const pickupAt = new Date(
      Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate() + index + 1, 15),
    ).toISOString();

    const id = `${batchId}-${String(index + 1).padStart(2, "0")}`;

    state.inventory.push({
      id,
      batchId,
      maximumCents: 220_000 + index * 5000,
      load: {
        id,
        reference: `NS-${batchId}-${String(index + 1).padStart(2, "0")}`,
        origin,
        destination,
        equipment,
        miles,
        pickupAt,
        pickupTimeZone,
        deliveryAt: new Date(Date.parse(pickupAt) + 86_400_000).toISOString(),
        commodity: equipment === "Reefer" ? "Chilled produce" : "Palletized goods",
        weightPounds: 32_000 + index * 100,
        postedRateCents: 200_000 + index * 5000,
        negotiation: [],
        pieces: 20,
        dimensions: "48 × 40 × 48 in per pallet",
      },
    });
  }

  return { added: 20, batchId };
}

export function checkAvailability(state: State, loadId: string, replacementId: string | null = null): boolean {
  return !state.agreements.some(
    (agreement): boolean =>
      agreement.load.id === loadId && agreement.status === "effective" && agreement.id !== replacementId,
  );
}

export function searchLoads(
  state: State,
  callId: string,
  query: {
    reference?: string;
    origin?: string;
    destination?: string;
    equipment?: string;
  },
): { loads: ReturnType<typeof describeLoad>[] } {
  const call = state.calls.find((call): boolean => call.id === callId)!;

  requireCondition(
    call.verification?.status === "eligible",
    "verification_required",
    "Verify an eligible carrier first.",
  );

  const normalize = (value: string): string => value.trim().replace(/\s+/g, " ").toLowerCase();

  const loads = state.inventory
    .filter((entry): boolean => call.inventoryIds.includes(entry.id) && checkAvailability(state, entry.id))
    .map((entry): State["inventory"][number]["load"] => entry.load)
    .filter(
      (load): boolean =>
        (!query.reference || normalize(load.reference) === normalize(query.reference)) &&
        (!query.origin || matchLocation(load.origin, query.origin)) &&
        (!query.destination || matchLocation(load.destination, query.destination)) &&
        (!query.equipment || normalize(load.equipment) === normalize(query.equipment)),
    )
    .slice(0, 5);

  if (loads.length) {
    call.record.matched = true;
  }

  return { loads: loads.map((load): ReturnType<typeof describeLoad> => describeLoad(state, callId, load)) };
}
