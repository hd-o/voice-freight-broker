import type { Session } from "./model";
import type { Identity } from "@voice-freight/contracts/business";
import { requireCondition } from "./model";
import { readState, transact } from "./repository";

export const localIdentities = [
  { id: "reviewer", name: "Local Reviewer", role: "reviewer" },
  { id: "reviewer-two", name: "Second Reviewer", role: "reviewer" },
  { id: "administrator", name: "Local Administrator", role: "administrator" },
] satisfies Identity[];

export function checkLocalAuthentication(environment: string | undefined, mode: string | undefined): void {
  requireCondition(
    environment === "local" && mode === "local",
    "auth_unavailable",
    "Local authentication is disabled in this environment.",
    503,
  );
}

export async function signIn(
  binding: D1Database,
  userId: string,
  now = new Date().toISOString(),
): Promise<{ user: Identity; session: Session }> {
  return transact(binding, (state): { user: Identity; session: Session } => {
    const user = localIdentities.find((user): boolean => user.id === userId);

    requireCondition(user, "invalid_identity", "Choose a local test identity.", 400);

    if (!state.users.some((entry): boolean => entry.id === user.id)) {
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

export async function queryIdentity(
  binding: D1Database,
  token: string | undefined,
  now = new Date().toISOString(),
): Promise<Identity | null> {
  if (!token) {
    return null;
  }

  const { state } = await readState(binding);

  const session = state.sessions.find((entry): boolean => entry.id === token && entry.expiresAt > now);

  return session ? (state.users.find((user): boolean => user.id === session.userId) ?? null) : null;
}

export async function signOut(binding: D1Database, token: string | undefined): Promise<void> {
  if (!token) {
    return;
  }

  await transact(binding, (state): void => {
    state.sessions = state.sessions.filter((session): boolean => session.id !== token);
  });
}
