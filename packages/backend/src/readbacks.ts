import type { Load } from "@voice-freight/contracts/calls";
import type { State } from "./model";

function describeRoute(load: Load): string {
  return `${load.origin.split(",")[0]} to ${load.destination.split(",")[0]} ${load.equipment.toLowerCase()}`;
}

export function describeLoad(state: State, callId: string, load: Load): Load & { spokenLabel: string } {
  const call = state.calls.find((entry): boolean => entry.id === callId)!;

  const date = load.pickupTimeZone
    ? new Intl.DateTimeFormat("en-US", {
        month: "long",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
        timeZoneName: "long",
        timeZone: load.pickupTimeZone,
      }).format(new Date(load.pickupAt))
    : "time zone unavailable";

  const peers = call.inventoryIds
    .map((id): (typeof state.inventory)[number] => state.inventory.find((entry): boolean => entry.id === id)!)
    .filter(
      (entry): boolean => describeRoute(entry.load) === describeRoute(load) && entry.load.pickupAt === load.pickupAt,
    );

  const option = peers.length > 1 ? `, option ${peers.findIndex((entry): boolean => entry.id === load.id) + 1}` : "";
  return { ...load, spokenLabel: `${describeRoute(load)}, pickup ${date}${option}` };
}

export function createReadback(
  state: State,
  callId: string,
  load: Load,
  rateCents: number,
  action: "handoff" | "cancel" | "replace",
): string {
  const call = state.calls.find((entry): boolean => entry.id === callId)!;
  return formatReadback(call.record.carrier!.name, describeLoad(state, callId, load).spokenLabel, rateCents, action);
}

export function formatReadback(
  carrierName: string,
  spokenLabel: string,
  rateCents: number,
  action: "handoff" | "cancel" | "replace",
): string {
  const intent = action === "cancel" ? " cancellation" : action === "replace" ? " replacement" : "";

  const rate = (rateCents / 100).toLocaleString("en-US", {
    minimumFractionDigits: rateCents % 100 ? 2 : 0,
    maximumFractionDigits: 2,
  });

  const question =
    action === "cancel"
      ? "Do you confirm cancelling this agreement?"
      : action === "replace"
        ? "Do you confirm replacing the existing agreement with these terms?"
        : "Do you accept these terms?";

  return `Please confirm${intent}: ${carrierName}, ${spokenLabel}, at ${rate} dollars. ${question}`;
}
