const states: Record<string, string> = {
  AL: "Alabama",
  AK: "Alaska",
  AZ: "Arizona",
  AR: "Arkansas",
  CA: "California",
  CO: "Colorado",
  CT: "Connecticut",
  DE: "Delaware",
  FL: "Florida",
  GA: "Georgia",
  HI: "Hawaii",
  ID: "Idaho",
  IL: "Illinois",
  IN: "Indiana",
  IA: "Iowa",
  KS: "Kansas",
  KY: "Kentucky",
  LA: "Louisiana",
  ME: "Maine",
  MD: "Maryland",
  MA: "Massachusetts",
  MI: "Michigan",
  MN: "Minnesota",
  MS: "Mississippi",
  MO: "Missouri",
  MT: "Montana",
  NE: "Nebraska",
  NV: "Nevada",
  NH: "New Hampshire",
  NJ: "New Jersey",
  NM: "New Mexico",
  NY: "New York",
  NC: "North Carolina",
  ND: "North Dakota",
  OH: "Ohio",
  OK: "Oklahoma",
  OR: "Oregon",
  PA: "Pennsylvania",
  RI: "Rhode Island",
  SC: "South Carolina",
  SD: "South Dakota",
  TN: "Tennessee",
  TX: "Texas",
  UT: "Utah",
  VT: "Vermont",
  VA: "Virginia",
  WA: "Washington",
  WV: "West Virginia",
  WI: "Wisconsin",
  WY: "Wyoming",
  DC: "District of Columbia",
};

const stateAliases = Object.entries(states)
  .flatMap(([code, name]): { alias: string; code: string }[] =>
    [code, name].map((alias): { alias: string; code: string } => ({ alias: alias.toLowerCase(), code })),
  )
  .sort((first, second): number => second.alias.length - first.alias.length);

function normalizeLocation(location: string): string {
  return location.toLowerCase().replaceAll(".", "").replaceAll(",", " ").trim().replace(/\s+/g, " ");
}

function parseLocation(location: string): { city: string; state: string | null } {
  const normalized = normalizeLocation(location);

  for (const { alias, code } of stateAliases) {
    if (normalized === alias) {
      return { city: "", state: code };
    }

    if (normalized.endsWith(` ${alias}`)) {
      return { city: normalized.slice(0, -(alias.length + 1)), state: code };
    }
  }

  return { city: normalized, state: null };
}

export function matchLocation(location: string, query: string): boolean {
  const locationParts = parseLocation(location);
  const queryParts = parseLocation(query);

  return (
    (!queryParts.state || locationParts.state === queryParts.state) &&
    (!queryParts.city || locationParts.city.includes(queryParts.city))
  );
}
