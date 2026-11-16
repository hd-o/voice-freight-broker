// Reset local daily call quotas through the running API while preserving the
// read-only inspection CLI, call history, spending ledger and active sessions.
import { parseArgs } from "node:util";

// Accept a loopback origin so the same command works with normal or stub Workers.
const { values } = parseArgs({
  options: {
    origin: { type: "string", default: "http://localhost:8787" },
    json: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});

if (values.help) {
  process.stdout.write(`Usage: vpr dev:reset:limits [--origin <url>] [--json]

Reset daily call quotas for all local users through the running Workers API.
Call history, spending and active-call checks are preserved.

Options:
  --origin <url>  Loopback API origin (default: http://localhost:8787).
  --json          Print the reset receipt as JSON.
  -h, --help      Show this help without contacting Workers.
`);
} else {
  try {
    const url = new URL(values.origin);

    if (
      !["http:", "https:"].includes(url.protocol) ||
      !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
      url.href !== `${url.origin}/`
    ) {
      throw new Error("Supply a loopback API origin, such as http://localhost:8787.");
    }

    const origin = url.origin;
    const headers = { Origin: origin, "Content-Type": "application/json" };

    // Local authentication supplies the administrator identity; no provider key
    // is needed, and redirects cannot send this operation to another server.
    const session = await fetch(new URL("/api/session", origin), {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
      headers,
      body: JSON.stringify({ userId: "administrator" }),
    });

    const cookie = session.headers.get("set-cookie")?.split(";")[0];

    if (!session.ok || !cookie) {
      throw new Error("Local administrator sign-in failed. Start local Workers and seed the development database.");
    }

    try {
      // The API performs one serialized quota-version change and enforces the
      // local-environment guard, independently of this client's origin check.
      const response = await fetch(new URL("/api/local/limits/reset", origin), {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
        headers: { ...headers, Cookie: cookie },
        body: "{}",
      });

      if (!response.ok) {
        throw new Error(`Daily quota reset failed (HTTP ${response.status}). Check local Workers and migrations.`);
      }

      const receipt: unknown = await response.json();
      process.stdout.write(
        values.json
          ? `${JSON.stringify(receipt)}\n`
          : "Local daily call quotas reset. Call history, spending and active-call checks are preserved.\n",
      );
    } finally {
      // Remove the short-lived administrator session created for this command.
      await fetch(new URL("/api/session", origin), {
        method: "DELETE",
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
        headers: { ...headers, Cookie: cookie },
      }).catch((): void => {});
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Local daily quota reset failed.";
    process.stderr.write(
      values.json ? `${JSON.stringify({ error: { code: "quota_reset_failed", message } })}\n` : `${message}\n`,
    );
    process.exitCode = 1;
  }
}
