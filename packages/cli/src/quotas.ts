import { CommandError } from "./errors.ts";

export async function resetDailyQuotas(origin: string): Promise<unknown> {
  let url: URL;

  try {
    url = new URL(origin);
  } catch {
    throw new CommandError(
      "usage_invalid",
      "Invalid API origin.",
      "Supply a loopback origin, such as http://localhost:8787.",
      2,
    );
  }

  if (
    !["http:", "https:"].includes(url.protocol) ||
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    url.href !== `${url.origin}/`
  ) {
    throw new CommandError(
      "usage_invalid",
      "Daily quota resets require a loopback API origin.",
      "Supply a loopback origin, such as http://localhost:8787.",
      2,
    );
  }

  const headers = { Origin: url.origin, "Content-Type": "application/json" };
  const hint = "Start local Workers and seed the development database; verify local migrations.";

  try {
    // Local authentication supplies the administrator identity. Redirects cannot
    // forward this operation to another server.
    const session = await fetch(new URL("/api/session", url.origin), {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
      headers,
      body: JSON.stringify({ userId: "administrator" }),
    });
    const cookie = session.headers.get("set-cookie")?.split(";")[0];

    if (!session.ok || !cookie) {
      throw new CommandError("quota_reset_failed", "Local administrator sign-in failed.", hint);
    }

    try {
      // Workers serialize the quota change and enforce the local-environment guard.
      const response = await fetch(new URL("/api/local/limits/reset", url.origin), {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
        headers: { ...headers, Cookie: cookie },
        body: "{}",
      });

      if (!response.ok) {
        throw new CommandError("quota_reset_failed", `Daily quota reset failed (HTTP ${response.status}).`, hint);
      }

      return await response.json();
    } finally {
      await fetch(new URL("/api/session", url.origin), {
        method: "DELETE",
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
        headers: { ...headers, Cookie: cookie },
      }).catch((): void => {});
    }
  } catch (error) {
    if (error instanceof CommandError) {
      throw error;
    }

    throw new CommandError(
      "quota_reset_failed",
      error instanceof Error ? error.message : "Local daily quota reset failed.",
      hint,
    );
  }
}
