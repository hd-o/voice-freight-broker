import type { Load } from "@voice-freight/contracts/calls";
import type { State } from "./model";

function describeRoute(load: Load) {
  return `${load.origin.split(",")[0]} to ${load.destination.split(",")[0]} ${load.equipment.toLowerCase()}`;
}

export function describeLoad(state: State, callId: string, load: Load) {
  const call = state.calls.find((entry) => entry.id === callId)!;
  const date = new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(load.pickupAt));
  const peers = call.inventoryIds
    .map((id) => state.inventory.find((entry) => entry.id === id)!)
    .filter(
      (entry) =>
        describeRoute(entry.load) === describeRoute(load) &&
        entry.load.pickupAt.slice(0, 10) === load.pickupAt.slice(0, 10),
    );
  const option = peers.length > 1 ? `, option ${peers.findIndex((entry) => entry.id === load.id) + 1}` : "";
  return { ...load, spokenLabel: `${describeRoute(load)}, pickup ${date}${option}` };
}

export function createReadback(
  state: State,
  callId: string,
  load: Load,
  rateCents: number,
  action: "handoff" | "cancel" | "replace",
) {
  const call = state.calls.find((entry) => entry.id === callId)!;
  const intent = action === "cancel" ? " cancellation" : action === "replace" ? " replacement" : "";
  const rate = (rateCents / 100).toLocaleString("en-US", {
    minimumFractionDigits: rateCents % 100 ? 2 : 0,
    maximumFractionDigits: 2,
  });
  return `Please confirm${intent}: ${call.record.carrier!.name}, ${describeLoad(state, callId, load).spokenLabel}, at ${rate} dollars. Please say yes, confirmed.`;
}
