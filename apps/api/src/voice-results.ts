const legacyMessages: Record<string, string> = {
  "Palletized demo goods": "Palletized goods",
  "Synthetic inventory. Simulated handoff only.": "",
  "MC number is not in the synthetic fixture set.": "No carrier was found for this MC number.",
  "Fixture contains an explicit disqualifying status.": "Carrier records contain a disqualifying status.",
  "Fixture evidence is missing or contradictory.": "Carrier verification information is missing or contradictory.",
};

// Project at the voice boundary so old inventory and replayed receipts retain
// their audit history without introducing provenance into the conversation.
export function projectVoiceResult(result: unknown): unknown {
  if (typeof result === "string") {
    return Object.hasOwn(legacyMessages, result) ? legacyMessages[result] : result;
  }

  if (Array.isArray(result)) {
    return result.map(projectVoiceResult);
  }

  if (!result || typeof result !== "object") {
    return result;
  }

  return Object.fromEntries(
    Object.entries(result)
      .filter(
        ([name, value]): boolean =>
          name !== "source" && name !== "fixtureVersion" && !(name === "handoff" && value === "simulated"),
      )
      .map(([name, value]): [string, unknown] => [name, projectVoiceResult(value)]),
  );
}
