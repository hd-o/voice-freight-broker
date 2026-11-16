import type { LiveCall } from "./live-call";
import type { Tools } from "../../tools/src/worker";
import type { UsageConfiguration } from "@voice-freight/backend/spending";

export interface LiveBindings extends UsageConfiguration {
  DB: D1Database;
  TOOLS: Service<Tools>;
  CALLS: DurableObjectNamespace<LiveCall>;
  OPENAI_API_KEY?: string;
  ANALYSIS_MODEL?: string;
  ANALYSIS_STUB_SCENARIO?: string;
  CONFIRMATION_STUB_SCENARIO?: string;
  ENVIRONMENT: string;
  AUTH_MODE: string;
  ACCESS_ISSUER?: string;
  ACCESS_AUDIENCE?: string;
  PUBLIC_ORIGIN?: string;
  LOCAL_ALLOWED_ORIGIN?: string;
  VOICE_PROVIDER?: string;
  VOICE_STUB_SCENARIO?: string;
}
