import type { Identity } from "@voice-freight/contracts/business";
import { requireCondition } from "./model";
import { readState, transact } from "./repository";

export const localIdentities = [
  { id: "reviewer", name: "Local Reviewer", role: "reviewer" },
  { id: "reviewer-two", name: "Second Reviewer", role: "reviewer" },
  { id: "administrator", name: "Local Administrator", role: "administrator" },
] satisfies Identity[];

export function checkLocalAuthentication(environment: string | undefined, mode: string | undefined) {
  requireCondition(
    environment === "local" && mode === "local",
    "auth_unavailable",
    "Local authentication is disabled in this environment.",
    503,
  );
}

export async function signIn(binding: D1Database, userId: string, now = new Date().toISOString()) {
  return transact(binding, (state) => {
    const user = localIdentities.find((user) => user.id === userId);

    requireCondition(user, "invalid_identity", "Choose a local test identity.", 400);

    if (!state.users.some((entry) => entry.id === user.id)) {
      state.users.push(user);
    }

    const session = {
      id: crypto.randomUUID(),
      userId: user.id,
      expiresAt: new Date(Date.parse(now) + 8 * 3_600_000).toISOString(),
    };

    state.sessions.push(session);

    return { user, session };
  });
}

export async function queryIdentity(binding: D1Database, token: string | undefined, now = new Date().toISOString()) {
  if (!token) {
    return null;
  }

  const { state } = await readState(binding);

  const session = state.sessions.find((entry) => entry.id === token && entry.expiresAt > now);

  return session ? (state.users.find((user) => user.id === session.userId) ?? null) : null;
}

export async function signOut(binding: D1Database, token: string | undefined) {
  if (!token) {
    return;
  }

  await transact(binding, (state) => {
    state.sessions = state.sessions.filter((session) => session.id !== token);
  });
}
