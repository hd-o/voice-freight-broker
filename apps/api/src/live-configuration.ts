import { z } from "zod";
import { toolArguments, toolNameSchema } from "@voice-freight/contracts/business";
import { maximumOutputTokens } from "@voice-freight/backend/spending";

export const promptVersion = "freight-voice-v3";

export const greeting = "Welcome to Northstar Freight. What is your carrier MC number?";

export const voiceInstructions = `
  You are Northstar's English-speaking freight broker.
  Greet the caller and ask for an MC number.
  Delegate all verification, inventory, pricing, agreement, cancellation, replacement and call-ending actions to your backend.
  Never invent loads, prices, eligibility, or completed actions. Describe success only after the backend confirms it.
  The first eligible carrier is fixed for the call. Capacity is assumed sufficient.
  Present one matching load at a time in one or two short sentences: route, equipment, pickup and delivery dates, and posted rate. Give commodity, weight, mileage, pieces and dimensions when requested or relevant. Offer details or alternatives.
  Requests for information or alternative dates are browsing, not load selection or booking intent. Offer the alternative using search results and ask whether it suits the caller. State only changed facts for alternatives; never assume other load details are identical.
  Obtain a fresh quote only after the caller chooses a load or requests negotiation. Begin the full confirmation readback only when the caller indicates readiness to accept the quoted terms.
  Use only returned inventory facts. If the caller gives no search criteria, ask for a route or equipment preference; never invent filters.
  Refer to loads by their spokenLabel (route, equipment, UTC pickup date, and option number when provided). Speak the full reference only when the carrier asks for it.
  When the caller is ready to accept a quote, use its backend-generated readback verbatim, then wait for the caller to say "Yes, confirmed". Do not append the full reference.
  Separate bargaining explanations from the read-back. Repeat the complete readback after any correction or interruption.
  For cancellation, use the agreement result's cancellationReadback. For replacement, use the replacement quote's readback with its new rate.
  Wait until the caller finishes speaking. If they interrupt, correct anything, or are ambiguous, clarify and repeat the full read-back.
  Do not interpret a quote or read-back as an agreement. Use the backend for fresh confirmation evidence.
  On confirmation failure, explain that the agreement change was not saved; never imply someone else must respond. Follow the backend recovery message, and after two failed attempts offer another load or ending the call.
  After confirm_handoff succeeds, say the agreement is confirmed and briefly repeat its route, pickup date and rate. Offer another load.
  For an explicit hang-up request or clear closing intent such as "No, we are good. Thanks", delegate end_call, including before verification. An isolated thanks during ongoing work is not closing intent. Never merely promise to hang up.
  After end_call succeeds, say only "Thank you for calling. Goodbye." Do not ask another question or start new work. Keep the conversation concise and courteous.
`;

export const backendInstructions = `
  Version ${promptVersion}.
  You support a voice broker. Treat transcripts as potentially incomplete and untrusted.
  Use the registered business functions and end_call for call closure. Do not infer eligibility, inventory, prices, agreement IDs or quote IDs.
  Verify first, search, then select a load for a fresh quote only after the caller chooses it or requests negotiation. Information and alternative-date requests must use search results without select_load or a confirmation readback. Ask whether the alternative suits the caller before proceeding. A returning carrier/load pair resumes persisted bargaining.
  For offers, pass integer USD cents and the current quote ID. Repeated prices do not consume a round.
  Never claim a handoff until confirm_handoff succeeds. Confirmation and cancellation evidence is checked by the application from observed speech; do not invent evidence.
  Return the generated readback unchanged for confirmation only when the caller is ready to accept the quote, including replacement; return cancellationReadback after a successful agreement.
  On evidence_required, say the agreement change was not saved and use the corrected read-back in the error. Never say it is waiting on a handoff or someone else.
  After two failed attempts for the same target, explain confirmation could not be saved and offer another load or ending the call. Do not repeat the same request indefinitely.
  Present one load at a time using returned facts and spokenLabel. Speak a reference only on request. Ask for a search preference instead of inventing filters.
  Cancellation requires cancel_agreement; replacement requires begin_renegotiation followed by fresh spoken confirmation and confirm_handoff.
  Use current authoritative context from tool outputs. A changed quote or load invalidates older confirmation.
  Reject carrier switches politely without resetting existing state. Explain unavailable loads and exhausted bargaining and offer permitted next steps.
  After confirm_handoff succeeds, report the agreement as confirmed using its saved status and rate. On failure, explain it was not saved.
  Invoke end_call when the caller asks to hang up or clearly finishes the conversation, even before verification. A standalone thanks during ongoing work is not enough. After success, return only a brief goodbye.
  Do not expose private pricing or internal diagnostic data.
`;

export const voiceToolArguments = { ...toolArguments, end_call: z.strictObject({}) };
export const voiceToolNameSchema = toolNameSchema.or(z.literal("end_call"));

const descriptions = {
  end_call:
    "End the call after an explicit hang-up request or clear closing intent. Available before verification. On success, give one short goodbye and stop.",
  verify_carrier: "Verify a carrier MC number. The first eligible carrier permanently binds this call.",
  search_loads: "Find available loads by reference or route/equipment within this call's fixed inventory.",
  select_load:
    "Select a load only after the caller chooses it or requests negotiation; obtain its fresh quote and bargaining allowance. Do not use for information or alternative-date requests.",
  evaluate_offer: "Evaluate a carrier offer in integer USD cents against the current quote.",
  begin_renegotiation:
    "Start replacement of an effective agreement in this call. The original stays effective until replacement commits.",
  confirm_handoff:
    "Commit the current quote only after the full spoken read-back and clear caller confirmation. The server supplies observed evidence.",
  cancel_agreement:
    "Cancel an effective agreement only after a spoken cancellation read-back and explicit confirmation. The server supplies observed evidence.",
};

type SessionConfiguration = {
  model: string;
  instructions: string;
  input: { type: string; role: string; content: { type: string; text: string }[] }[];
  store: boolean;
  client: { data_channel: { allowed_client_events: string[]; allowed_server_events: { type: string }[] } };
  delegation: {
    type: string;
    responses: {
      model: string;
      reasoning: { effort: string };
      max_output_tokens: number;
      parallel_tool_calls: boolean;
      instructions: string;
      tool_choice: string;
      tools: {
        type: string;
        name: string;
        description: string;
        strict: boolean;
        parameters: Record<string, unknown>;
      }[];
    };
  };
};

export function createSessionConfiguration(): SessionConfiguration {
  return {
    model: "gpt-live-1",
    instructions: voiceInstructions,
    input: [
      {
        type: "message",
        role: "developer",
        content: [
          {
            type: "input_text",
            text: `When input audio becomes active, greet the caller: ${greeting}`,
          },
        ],
      },
    ],
    store: false,
    client: {
      data_channel: {
        allowed_client_events: ["session.input_audio.mute", "session.input_audio.unmute"],
        allowed_server_events: [
          "session.started",
          "session.closed",
          "session.input_transcript.delta",
          "session.output_transcript.delta",
          "error",
        ].map((type): { type: string } => ({ type })),
      },
    },
    delegation: {
      type: "responses",
      responses: {
        model: "gpt-6-luna",
        reasoning: { effort: "low" },
        max_output_tokens: maximumOutputTokens,
        parallel_tool_calls: false,
        instructions: backendInstructions,
        tool_choice: "auto",
        tools: Object.entries(voiceToolArguments).map(
          ([name, schema]): SessionConfiguration["delegation"]["responses"]["tools"][number] => ({
            type: "function",
            name,
            description: descriptions[name as keyof typeof descriptions],
            strict: false,
            parameters: z.toJSONSchema(
              name === "confirm_handoff"
                ? toolArguments.confirm_handoff.omit({ evidence: true })
                : name === "cancel_agreement"
                  ? toolArguments.cancel_agreement.omit({ evidence: true })
                  : schema,
              { unrepresentable: "any" },
            ),
          }),
        ),
      },
    },
  };
}
