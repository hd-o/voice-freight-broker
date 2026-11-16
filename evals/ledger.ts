import { z } from "zod";
import { readState, transact } from "../packages/backend/src/repository";
import { requireCondition } from "../packages/backend/src/model";
import {
  calculateAvailableMicrodollars,
  calculateResponseCostMicrodollars,
  chargeUsage,
  fastModelPrices,
  modelPrices,
  resolvePeriod,
} from "../packages/backend/src/spending";
import { confirmationModel, confirmationPrices } from "../packages/backend/src/confirmation-policy";

const reservationSchema = z.strictObject({
  action: z.literal("reserve"),
  id: z.string().min(1),
  runId: z.string().uuid(),
  path: z.enum(["/v1/responses", "/v1/decisions"]),
  body: z
    .object({
      model: z.string(),
      max_output_tokens: z.number().int().positive().max(2048).optional(),
      service_tier: z.enum(["fast", "priority"]).optional(),
    })
    .passthrough(),
});

const settlementSchema = z.strictObject({
  action: z.literal("settle"),
  id: z.string(),
  providerId: z.string(),
  createdAt: z.string().datetime(),
  inputTokens: z.number().int().nonnegative(),
  cachedInputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheWriteTokens: z.number().int().nonnegative(),
});

// This worker is bundled only by the local evaluation runner. It has no
// production route or Wrangler deployment configuration.
export default {
  async fetch(request: Request, env: { DB: D1Database }): Promise<Response> {
    try {
      const input: unknown = await request.json();
      const now = new Date().toISOString();

      if (reservationSchema.safeParse(input).success) {
        const command = reservationSchema.parse(input);
        const bound = new TextEncoder().encode(JSON.stringify(command.body)).byteLength + 16384;
        const decisions = command.path === "/v1/decisions";
        const prices = decisions ? confirmationPrices : command.body.service_tier ? fastModelPrices : modelPrices;

        requireCondition(
          command.body.model === confirmationModel && bound <= 100_000,
          "evaluation_bound",
          "Unpriced model or excessive evaluation input.",
        );
        const amount = calculateResponseCostMicrodollars(
          bound,
          0,
          decisions ? 0 : (command.body.max_output_tokens ?? 2048),
          prices,
        );

        await transact(env.DB, (state): void => {
          requireCondition(
            !state.reservations.some((entry): boolean => entry.id === command.id),
            "evaluation_replay",
            "A paid evaluation request cannot be replayed.",
          );
          const reservations = state.reservations.filter(
            (entry): boolean => entry.kind === "evaluation" && entry.operationId.startsWith(`${command.runId}:`),
          );
          const exposure = reservations.reduce(
            (total, entry): number =>
              total +
              (entry.settled
                ? entry.chargedMicrodollars
                : Math.max(entry.reservedMicrodollars, entry.chargedMicrodollars)),
            0,
          );

          requireCondition(
            reservations.length < 320 && exposure + amount <= 1_000_000,
            "evaluation_limit",
            "Evaluation run reached its request or $1 spending bound.",
          );
          requireCondition(
            calculateAvailableMicrodollars(state, now) >= amount,
            "budget_exhausted",
            "The shared monthly allowance cannot cover this evaluation request.",
          );
          state.reservations.push({
            id: command.id,
            operationId: `${command.runId}:${command.id}`,
            ownerId: "administrator",
            kind: "evaluation",
            createdAt: now,
            prices,
            reservedMicrodollars: amount,
            chargedMicrodollars: 0,
            settled: false,
          });
        });

        return Response.json({ reservedMicrodollars: amount });
      }

      const command = settlementSchema.parse(input);
      await transact(env.DB, (state): void => {
        const reservation = state.reservations.find((entry): boolean => entry.id === command.id);
        requireCondition(
          reservation?.kind === "evaluation",
          "evaluation_reservation",
          "Evaluation reservation unavailable.",
        );
        // Responses cache writes remain ordinary uncached input. Decisions has
        // a separate uncached-only pricing contract in the application.
        requireCondition(
          reservation.prices.version !== confirmationPrices.version || command.cacheWriteTokens === 0,
          "usage_uncertain",
          "Unpriced Decisions cache writes retain the reservation.",
        );
        const cost = calculateResponseCostMicrodollars(
          command.inputTokens,
          command.cachedInputTokens,
          command.outputTokens,
          reservation.prices,
        );

        chargeUsage(
          state,
          command.id,
          `evaluation-provider:${command.providerId}`,
          resolvePeriod(command.createdAt),
          cost,
        );
        reservation.settled = true;
      });

      const { state } = await readState(env.DB);
      return Response.json(state.reservations.find((entry): boolean => entry.id === command.id));
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : "Evaluation accounting failed." },
        { status: 409 },
      );
    }
  },
};
