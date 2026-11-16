import { authorizeAdministrator } from "./authorization";
import { requireCondition } from "./model";
import { transact } from "./repository";

export type QuotaReset = {
  id: string;
  version: string;
  resetAt: string;
};

export const localDailyQuotaId = "local-daily";

export async function resetDailyQuotas(
  binding: D1Database,
  userId: string,
  configuration: { ENVIRONMENT: string; AUTH_MODE: string },
  now = new Date().toISOString(),
): Promise<{ scope: "daily_calls"; resetAt: string }> {
  requireCondition(
    configuration.ENVIRONMENT === "local" && configuration.AUTH_MODE === "local",
    "forbidden",
    "Daily quota resets are available only in local development.",
    403,
  );

  return transact(binding, (state): { scope: "daily_calls"; resetAt: string } => {
    authorizeAdministrator(state, userId);
    const reset = { id: localDailyQuotaId, version: crypto.randomUUID(), resetAt: now };
    const index = state.quotaResets.findIndex((entry): boolean => entry.id === localDailyQuotaId);

    if (index === -1) {
      state.quotaResets.push(reset);
    } else {
      state.quotaResets[index] = reset;
    }

    return { scope: "daily_calls", resetAt: now };
  });
}
