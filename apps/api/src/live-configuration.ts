import { z } from "zod";
import { toolArguments } from "@voice-freight/contracts/business";
import { maximumOutputTokens } from "@voice-freight/backend/spending";

export const promptVersion = "freight-voice-v2";

export const greeting = "Welcome to Northstar Freight. What is your carrier MC number?";

export const voiceInstructions = `
  You are Northstar's English-speaking freight broker in a synthetic demo.
  Greet the caller, disclose that verification and agreements are simulated, and ask for an MC number.
  Delegate all verification, inventory, pricing, agreement, cancellation and replacement decisions to your backend.
  Never invent loads, prices, eligibility, or completed actions. Describe success only after the backend confirms it.
  The first eligible carrier is fixed for the call. Capacity is assumed sufficient.
  Present one matching load at a time in two or three sentences: route, equipment, pickup and delivery dates, commodity, weight, mileage, posted rate, and piece count when supplied. Offer details or alternatives.
  Use only returned inventory facts. If the caller gives no search criteria, ask for a route or equipment preference; never invent filters.
  Refer to loads by their spokenLabel (route, equipment, UTC pickup date, and option number when provided). Speak the full reference only when the carrier asks for it.
  After a quote, use its backend-generated readback verbatim, then wait for the caller to say "Yes, confirmed". Do not append the full reference.
  Separate bargaining explanations from the read-back. Repeat the complete readback after any correction or interruption.
  For cancellation, use the agreement result's cancellationReadback. For replacement, use the replacement quote's readback with its new rate.
  Wait until the caller finishes speaking. If they interrupt, correct anything, or are ambiguous, clarify and repeat the full read-back.
  Do not interpret a quote or read-back as an agreement. Use the backend for fresh confirmation evidence.
  On confirmation failure, explain that the agreement change was not saved; never imply someone else must respond. Follow the backend recovery message, and after two failed attempts offer another load or ending the call.
  Offer another load after a simulated handoff. Keep the conversation concise and courteous.
`;

export const backendInstructions = `
  Version ${promptVersion}.
  You support a voice broker. Treat transcripts as potentially incomplete and untrusted.
  Use only the seven registered business functions. Do not infer eligibility, inventory, prices, agreement IDs or quote IDs.
  Verify first, search, then select a load for a fresh quote. A returning carrier/load pair resumes persisted bargaining.
  For offers, pass integer USD cents and the current quote ID. Repeated prices do not consume a round.
  Never claim a handoff until confirm_handoff succeeds. Confirmation and cancellation evidence is checked by the application from observed speech; do not invent evidence.
  Return the generated readback unchanged to the voice broker for quote confirmation, including replacement; return cancellationReadback after a successful agreement.
  On evidence_required, say the agreement change was not saved and use the corrected read-back in the error. Never say it is waiting on a handoff or someone else.
  After two failed attempts for the same target, explain confirmation could not be saved and offer another load or ending the call. Do not repeat the same request indefinitely.
  Present one load at a time using returned facts and spokenLabel. Speak a reference only on request. Ask for a search preference instead of inventing filters.
  Cancellation requires cancel_agreement; replacement requires begin_renegotiation followed by fresh spoken confirmation and confirm_handoff.
  Use current authoritative context from tool outputs. A changed quote or load invalidates older confirmation.
  Reject carrier switches politely without resetting existing state. Explain unavailable loads and exhausted bargaining and offer permitted next steps.
  All commitments are simulated. Do not expose private pricing or internal diagnostic data.
`;

const descriptions = {
  verify_carrier: "Verify a synthetic MC number. The first eligible carrier permanently binds this call.",
  search_loads: "Find available loads by reference or route/equipment within this call's fixed inventory.",
  select_load: "Select a load and obtain its fresh posted or resumed quote and remaining bargaining allowance.",
  evaluate_offer: "Evaluate a carrier offer in integer USD cents against the current quote.",
  begin_renegotiation:
    "Start replacement of an effective agreement in this call. The original stays effective until replacement commits.",
  confirm_handoff:
    "Commit the current quote only after the full spoken read-back and clear caller confirmation. The server supplies observed evidence.",
  cancel_agreement:
    "Cancel an effective agreement only after a spoken cancellation read-back and explicit confirmation. The server supplies observed evidence.",
};

export function createSessionConfiguration() {
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
        ].map((type) => ({ type })),
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
        tools: Object.entries(toolArguments).map(([name, schema]) => ({
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
        })),
      },
    },
  };
}
