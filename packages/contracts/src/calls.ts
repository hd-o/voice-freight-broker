import { z } from "zod";

const moneySchema = z.number().int().nonnegative();

export const loadSchema = z
  .object({
    id: z.string().min(1),
    reference: z.string().min(1),
    origin: z.string().min(1),
    destination: z.string().min(1),
    equipment: z.string().min(1),
    miles: z.number().int().positive(),
    pickupAt: z.iso.datetime(),
    deliveryAt: z.iso.datetime(),
    commodity: z.string().min(1),
    weightPounds: z.number().int().positive(),
    postedRateCents: moneySchema,
    negotiation: z.array(
      z.object({
        kind: z.enum(["Carrier offer", "Broker counter"]),
        rateCents: moneySchema,
      }),
    ),
  })
  .refine((load) => Date.parse(load.pickupAt) < Date.parse(load.deliveryAt), {
    message: "Pickup must precede delivery",
  });

export const agreementSchema = z.object({
  id: z.string().min(1),
  loadId: z.string().min(1),
  version: z.number().int().positive(),
  status: z.enum(["effective", "cancelled", "superseded"]),
  rateCents: moneySchema,
});

export const callSchema = z
  .object({
    id: z.string().min(1),
    source: z.enum(["Sample", "Live"]),
    startedAt: z.iso.datetime(),
    endedAt: z.iso.datetime().nullable(),
    carrier: z
      .object({ name: z.string().min(1), mcNumber: z.string().min(1) })
      .nullable(),
    eligibility: z.enum(["Eligible", "Ineligible", "Unknown", "Unavailable"]),
    matched: z.boolean(),
    unresolvedError: z.boolean(),
    connection: z.enum(["Ended normally", "Interrupted", "Connection failed"]),
    outcomeReason: z.enum([
      "No agreement",
      "Carrier ineligible",
      "No matching load",
      "Caller ended",
      "System error",
      "All agreements cancelled",
    ]),
    loads: z.array(loadSchema),
    agreements: z.array(agreementSchema),
    analysis: z.object({
      status: z.enum(["pending", "complete", "failed"]),
      sentiment: z.enum(["Positive", "Neutral", "Negative", "Unknown"]),
      summary: z.string().nullable(),
    }),
    transcript: z.object({
      complete: z.boolean(),
      entries: z.array(
        z.object({
          id: z.string().min(1),
          speaker: z.enum(["carrier", "broker"]),
          offsetSeconds: z.number().int().nonnegative(),
          text: z.string().min(1),
        }),
      ),
    }),
  })
  .superRefine((call, context) => {
    if (
      call.endedAt !== null &&
      Date.parse(call.endedAt) < Date.parse(call.startedAt)
    ) {
      context.addIssue({ code: "custom", message: "Call end precedes start" });
    }

    const loadIds = new Set(call.loads.map((load) => load.id));
    const versions = new Set<string>();
    const effectiveLoads = new Set<string>();

    for (const agreement of call.agreements) {
      const version = `${agreement.id}:${agreement.version}`;

      if (!loadIds.has(agreement.loadId) || versions.has(version)) {
        context.addIssue({
          code: "custom",
          message: "Invalid agreement reference or duplicate version",
        });
      }

      versions.add(version);

      if (agreement.status === "effective") {
        if (effectiveLoads.has(agreement.loadId)) {
          context.addIssue({
            code: "custom",
            message: "Multiple effective agreements for one load",
          });
        }

        effectiveLoads.add(agreement.loadId);
      }
    }

    if (loadIds.size !== call.loads.length) {
      context.addIssue({ code: "custom", message: "Duplicate load identity" });
    }

    if (
      call.analysis.status !== "complete" &&
      call.analysis.sentiment !== "Unknown"
    ) {
      context.addIssue({
        code: "custom",
        message: "Unfinished analysis has unknown sentiment",
      });
    }
  });

export const callsSchema = z
  .array(callSchema)
  .refine(
    (calls) => new Set(calls.map((call) => call.id)).size === calls.length,
    { message: "Duplicate call identity" },
  );

export type Call = z.infer<typeof callSchema>;
export type Load = z.infer<typeof loadSchema>;
