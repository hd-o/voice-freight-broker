import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { reconcileVoice } from "../src/voice-reconciliation.ts";

it("previews and releases a saved voice hold once without changing usage or delegated funds", async (): Promise<void> => {
  const database = new DatabaseSync(":memory:");
  const accountId = "00000000000000000000000000000001";
  const databaseId = "00000000-0000-4000-8000-000000000001";
  const callId = "00000000-0000-4000-8000-000000000002";
  const providerId = "live-test";
  const usageId = `${callId}:voice:2026-11`;
  const configuration = {
    accountId,
    databaseId,
    databaseName: "test",
    administrators: ["test@example.com"],
    reviewers: [],
  };

  database.exec(`
    CREATE TABLE reservations (id TEXT PRIMARY KEY, data TEXT);
    CREATE TABLE liveSessions (id TEXT PRIMARY KEY, data TEXT);
    CREATE TABLE providerUsage (id TEXT PRIMARY KEY, data TEXT);
    CREATE TABLE revision (id INTEGER PRIMARY KEY, version INTEGER);
    CREATE TABLE guard (id TEXT PRIMARY KEY, valid INTEGER CHECK(valid = 1));
    INSERT INTO revision VALUES (1, 0);
  `);

  database.prepare("INSERT INTO reservations VALUES (?, ?)").run(
    callId,
    JSON.stringify({
      id: callId,
      reservedMicrodollars: 9_699_540,
      chargedMicrodollars: 51_000,
      settled: false,
      prices: { voiceMicrodollarsPerMinute: 50_000 },
    }),
  );
  database.prepare("INSERT INTO liveSessions VALUES (?, ?)").run(
    callId,
    JSON.stringify({
      id: callId,
      providerId,
      providerClosed: true,
      usageConfirmed: true,
      state: "ended",
      voiceSeconds: 60,
      maximumCallSeconds: 600,
      accountingGap: true,
    }),
  );
  database.prepare("INSERT INTO providerUsage VALUES (?, ?)").run(
    usageId,
    JSON.stringify({
      id: usageId,
      callId,
      periodId: "2026-11",
      costMicrodollars: 50_000,
    }),
  );

  vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", accountId);
  vi.stubEnv("CLOUDFLARE_API_TOKEN", "test-token");
  vi.stubEnv("TEST_HOSTING_CONFIGURATION", JSON.stringify(configuration));

  const request = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, options): Promise<Response> => {
    if (!options?.body) {
      return Response.json({ success: true, result: { name: "test" } });
    }

    if (typeof options.body !== "string") {
      throw new Error("Expected a JSON query body.");
    }

    const { sql }: { sql: string } = JSON.parse(options.body);

    if (sql.startsWith("SELECT")) {
      return Response.json({ success: true, result: [{ results: database.prepare(sql).all() }] });
    }

    database.exec(`BEGIN; ${sql} COMMIT;`);
    return Response.json({ success: true, result: [] });
  });

  try {
    const preview = await reconcileVoice([callId], undefined, "TEST_HOSTING_CONFIGURATION");
    expect(preview.applied).toBe(false);
    expect(preview.calls[0]).toMatchObject({
      voiceReleaseMicrodollars: 637_500,
      remainingDelegatedHoldMicrodollars: 9_011_040,
    });
    await expect(reconcileVoice([callId], "stale-preview", "TEST_HOSTING_CONFIGURATION")).rejects.toMatchObject({
      code: "preview_changed",
    });
    expect(database.prepare("SELECT version FROM revision").get()?.version).toBe(0);

    const applied = await reconcileVoice([callId], preview.previewToken, "TEST_HOSTING_CONFIGURATION");
    expect(applied.applied).toBe(true);
    const receipt = database.prepare("SELECT data FROM reservations").get();
    expect(JSON.parse(String(receipt?.data))).toMatchObject({
      chargedMicrodollars: 51_000,
      settled: false,
      callSpending: {
        voiceSettled: true,
        voiceReconciliation: { providerSessionId: providerId, finalVoiceSeconds: 60 },
      },
    });

    const replay = await reconcileVoice([callId], preview.previewToken, "TEST_HOSTING_CONFIGURATION");
    expect(replay).toMatchObject({ applied: false, calls: [{ voiceReleaseMicrodollars: 0 }] });
    expect(database.prepare("SELECT version FROM revision").get()?.version).toBe(1);
  } finally {
    request.mockRestore();
    vi.unstubAllEnvs();
    database.close();
  }
});
