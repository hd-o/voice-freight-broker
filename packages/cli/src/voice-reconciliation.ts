import { createHash, randomUUID } from "node:crypto";
import type { Reservation } from "@voice-freight/backend/model";
import { calculateReservationHold, resolveCallSpending } from "@voice-freight/backend/spending";
import { z } from "zod";
import { CommandError } from "./errors.ts";
import { openDeployedDatabase, quoteSql } from "./hosting.ts";

const amount = z.number().int().nonnegative();
const reservationSchema = z.looseObject({
  id: z.uuid(),
  kind: z.literal("call").optional(),
  reservedMicrodollars: amount,
  chargedMicrodollars: amount,
  settled: z.boolean(),
  prices: z.looseObject({ voiceMicrodollarsPerMinute: amount }),
  callSpending: z
    .looseObject({
      voiceReservedMicrodollars: amount,
      voiceChargedMicrodollars: amount,
      voiceSettled: z.boolean(),
      delegatedHoldLimitMicrodollars: amount.optional(),
    })
    .optional(),
});
const sessionSchema = z.object({
  id: z.uuid(),
  providerId: z.string().min(1),
  state: z.literal("ended"),
  providerClosed: z.literal(true),
  usageConfirmed: z.literal(true),
  maximumCallSeconds: amount,
  voiceSeconds: z.number().nonnegative(),
});
const usageSchema = z.array(
  z.object({ id: z.string(), callId: z.uuid(), periodId: z.string(), costMicrodollars: amount }),
);

type VoiceReconciliation = {
  previewToken: string;
  calls: {
    callId: string;
    finalVoiceSeconds: number;
    voiceChargedMicrodollars: number;
    voiceReleaseMicrodollars: number;
    remainingDelegatedHoldMicrodollars: number;
  }[];
  applied: boolean;
};

export async function reconcileVoice(
  callIds: string[],
  reviewedToken?: string,
  configurationEnv?: string,
): Promise<VoiceReconciliation> {
  const database = await openDeployedDatabase(configurationEnv);
  const ids = [...new Set(callIds)].sort();

  const sql = `SELECT revision.version, reservations.data AS reservation, liveSessions.data AS session,
    (SELECT json_group_array(json(data)) FROM
      (SELECT data FROM providerUsage WHERE id LIKE reservations.id || ':voice:%' ORDER BY id)) AS usage
    FROM reservations JOIN liveSessions ON liveSessions.id = reservations.id CROSS JOIN revision
    WHERE revision.id = 1 AND reservations.id IN (${ids.map(quoteSql).join(",")}) ORDER BY reservations.id;`;

  const [{ results }] = z
    .tuple([
      z.object({
        results: z.array(
          z.object({
            version: amount,
            reservation: z.string(),
            session: z.string(),
            usage: z.string(),
          }),
        ),
      }),
    ])
    .parse(await database.query(sql));

  if (results.length !== ids.length) {
    throw new CommandError(
      "calls_missing",
      "A requested call or reservation is missing.",
      "Check the deployed call IDs.",
    );
  }

  const previewToken = createHash("sha256")
    .update(
      JSON.stringify([database.id, results.map(({ reservation, session, usage }) => [reservation, session, usage])]),
    )
    .digest("hex");

  const at = new Date().toISOString();
  const updates: Reservation[] = [];

  const calls = results.map((row): VoiceReconciliation["calls"][number] => {
    const reservation = reservationSchema.parse(JSON.parse(row.reservation)) as Reservation;
    const session = sessionSchema.parse(JSON.parse(row.session));
    const usage = usageSchema.parse(JSON.parse(row.usage));
    const spending = resolveCallSpending(reservation, session, usage);
    const savedVoiceCharge = usage.reduce((total, entry): number => total + entry.costMicrodollars, 0);

    if (
      session.id !== reservation.id ||
      spending.voiceChargedMicrodollars !== savedVoiceCharge ||
      savedVoiceCharge < Math.ceil((session.voiceSeconds * reservation.prices.voiceMicrodollarsPerMinute) / 60) ||
      savedVoiceCharge > reservation.chargedMicrodollars
    ) {
      throw new CommandError(
        "voice_usage_invalid",
        `Cannot verify saved voice usage for call ${session.id}.`,
        "Check the final provider duration and existing voice charges before releasing funds.",
      );
    }

    const before = calculateReservationHold(reservation);
    const updated = { ...reservation, callSpending: { ...spending, voiceSettled: true } };
    updated.settled = spending.delegatedHoldLimitMicrodollars === 0;
    const after = calculateReservationHold(updated);

    if (after > before) {
      throw new CommandError(
        "hold_increased",
        `The voice reconciliation would increase the hold for call ${session.id}.`,
        "Review the existing spending record before adjusting this reservation.",
      );
    }

    if (!spending.voiceSettled) {
      updated.callSpending.voiceReconciliation = {
        id: `${previewToken}:${session.id}`,
        at,
        providerSessionId: session.providerId,
        finalVoiceSeconds: session.voiceSeconds,
        heldBeforeMicrodollars: before,
        heldAfterMicrodollars: after,
      };

      updates.push(updated);
    }

    return {
      callId: session.id,
      finalVoiceSeconds: session.voiceSeconds,
      voiceChargedMicrodollars: savedVoiceCharge,
      voiceReleaseMicrodollars: before - after,
      remainingDelegatedHoldMicrodollars: after,
    };
  });

  if (!reviewedToken || !updates.length) {
    return { previewToken, calls, applied: false };
  }

  if (reviewedToken !== previewToken) {
    throw new CommandError("preview_changed", "The reviewed voice preview no longer matches.", "Run a fresh preview.");
  }

  // Use the same atomic revision guard as Worker writes so a concurrent
  // usage update cannot be overwritten or accepted against the old ledger.
  const guard = quoteSql(randomUUID());
  await database.query(
    [
      `INSERT INTO guard (id, valid) VALUES (${guard}, (SELECT version = ${results[0].version} FROM revision WHERE id = 1));`,
      ...updates.map(
        (row): string =>
          `UPDATE reservations SET data = ${quoteSql(JSON.stringify(row))} WHERE id = ${quoteSql(row.id)};`,
      ),
      "UPDATE revision SET version = version + 1 WHERE id = 1;",
      `DELETE FROM guard WHERE id = ${guard};`,
    ].join("\n"),
  );

  return { previewToken, calls, applied: true };
}
