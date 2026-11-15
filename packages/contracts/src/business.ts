import { z } from "zod";

export const identitySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  role: z.enum(["reviewer", "administrator"]),
});

export type Identity = z.infer<typeof identitySchema>;

export const errorSchema = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
});

const referenceSchema = z.string().min(1).max(160);

export const evidenceReferencesSchema = z.object({
  readbackId: referenceSchema,
  callerId: referenceSchema,
});

export const toolArguments = {
  verify_carrier: z.strictObject({ mcNumber: z.string().regex(/^\d{6,7}$/) }),
  search_loads: z
    .strictObject({
      reference: z.string().trim().min(1).max(100).optional(),
      origin: z.string().trim().min(1).max(100).optional(),
      destination: z.string().trim().min(1).max(100).optional(),
      equipment: z.string().trim().min(1).max(100).optional(),
    })
    .refine((query): string | undefined => query.reference || query.origin || query.destination || query.equipment, {
      message: "Provide a reference or route/equipment preference",
    }),
  select_load: z.strictObject({ loadId: referenceSchema }),
  evaluate_offer: z.strictObject({
    quoteId: referenceSchema,
    amountCents: z.number().int().positive().max(100_000_000),
  }),
  begin_renegotiation: z.strictObject({ agreementId: referenceSchema }),
  confirm_handoff: z.strictObject({
    quoteId: referenceSchema,
    evidence: evidenceReferencesSchema,
  }),
  cancel_agreement: z.strictObject({
    agreementId: referenceSchema,
    evidence: evidenceReferencesSchema,
  }),
};

export const toolNameSchema = z.enum([
  "verify_carrier",
  "search_loads",
  "select_load",
  "evaluate_offer",
  "begin_renegotiation",
  "confirm_handoff",
  "cancel_agreement",
]);

export type ToolName = z.infer<typeof toolNameSchema>;

export const invocationSchema = z.strictObject({
  invocationId: referenceSchema,
  arguments: z.unknown(),
});

export const callContextSchema = z.strictObject({
  userId: referenceSchema,
  callId: referenceSchema,
});

export type CallContext = z.infer<typeof callContextSchema>;

export const finalizationSchema = z.strictObject({
  connection: z.enum(["Ended normally", "Interrupted", "Connection failed"]),
  transcriptComplete: z.boolean(),
});

// Only a trusted coordinator may record these server-observed transcript events.
export const evidenceSchema = z.strictObject({
  id: referenceSchema,
  speaker: z.enum(["broker", "carrier"]),
  text: z.string().trim().min(1).max(8000),
  offsetSeconds: z.number().int().nonnegative(),
  action: z.enum(["handoff", "cancel"]),
  targetId: referenceSchema,
  readbackId: referenceSchema.optional(),
  confirmed: z.boolean(),
});

export type EvidenceInput = z.infer<typeof evidenceSchema>;
