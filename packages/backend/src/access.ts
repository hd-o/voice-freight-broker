import { createRemoteJWKSet, jwtVerify } from "jose";
import type { Identity } from "@voice-freight/contracts/business";
import { BusinessError, requireCondition } from "./model";
import { readState, transact } from "./repository";

export type AccessConfiguration = {
  ACCESS_ISSUER?: string;
  ACCESS_AUDIENCE?: string;
};

const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

export async function verifyAccessToken(
  token: string | undefined,
  configuration: AccessConfiguration,
): Promise<{
  userId: string;
  expiration: string;
  tokenId: string;
}> {
  requireCondition(token, "unauthenticated", "Sign in to continue.", 401);
  const { ACCESS_ISSUER: issuer, ACCESS_AUDIENCE: audience } = configuration;
  requireCondition(issuer && audience, "auth_unavailable", "Deployed authentication is not configured.", 503);
  const domain = new URL(issuer);

  requireCondition(
    domain.protocol === "https:" && domain.hostname.endsWith(".cloudflareaccess.com") && issuer === domain.origin,
    "auth_unavailable",
    "Invalid Access issuer configuration.",
    503,
  );

  let keys = keySets.get(issuer);

  if (!keys) {
    keys = createRemoteJWKSet(new URL("/cdn-cgi/access/certs", issuer));
    keySets.set(issuer, keys);
  }

  try {
    const { payload } = await jwtVerify(token, keys, {
      issuer,
      audience,
      algorithms: ["RS256"],
      requiredClaims: ["exp", "sub", "email"],
    });

    requireCondition(
      typeof payload.email === "string" &&
        payload.email.includes("@") &&
        payload.type === "app" &&
        typeof payload.exp === "number",
      "unauthenticated",
      "A verified Access user session is required.",
      401,
    );

    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
    const tokenId = Array.from(new Uint8Array(digest), (byte): string => byte.toString(16).padStart(2, "0")).join("");

    return {
      userId: `access:${payload.email.toLowerCase()}`,
      expiration: new Date(payload.exp * 1000).toISOString(),
      tokenId: `access-revoked:${tokenId}`,
    };
  } catch (error) {
    if (error instanceof BusinessError) {
      throw error;
    }

    throw new BusinessError("unauthenticated", "Session expired or invalid. Sign in again.", 401);
  }
}

export async function queryAccessIdentity(
  binding: D1Database,
  token: string | undefined,
  configuration: AccessConfiguration,
): Promise<Identity> {
  const claims = await verifyAccessToken(token, configuration);
  const { state } = await readState(binding);
  requireCondition(
    !state.sessions.some((session): boolean => session.id === claims.tokenId),
    "unauthenticated",
    "Session signed out. Sign in again.",
    401,
  );
  const user = state.users.find((entry): boolean => entry.id === claims.userId);
  requireCondition(user, "forbidden", "This account has not been invited to the demo.", 403);
  return user;
}

export async function revokeAccessSession(
  binding: D1Database,
  token: string | undefined,
  configuration: AccessConfiguration,
): Promise<void> {
  const claims = await verifyAccessToken(token, configuration);

  await transact(binding, (state): void => {
    if (!state.sessions.some((session): boolean => session.id === claims.tokenId)) {
      state.sessions.push({ id: claims.tokenId, userId: claims.userId, expiresAt: claims.expiration });
    }
  });
}
