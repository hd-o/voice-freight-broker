import { queryAccessIdentity, revokeAccessSession } from "@voice-freight/backend/access";
import { observeOperation } from "@voice-freight/backend/telemetry";
import { evaluateConfirmation, confirmationEvaluationSchema } from "@voice-freight/backend/confirmation-evaluations";
import { classifyConfirmation } from "@voice-freight/backend/confirmation-provider";
import { resetDailyQuotas } from "@voice-freight/backend/quotas";
import { Hono, type Context } from "hono";
import { checkDatabase } from "@voice-freight/backend";
import { statusSchema } from "@voice-freight/contracts";
import { toolNameSchema, invocationSchema, finalizationSchema, type Identity } from "@voice-freight/contracts/business";
import { executeTool } from "@voice-freight/backend/business";
import { createCall } from "@voice-freight/backend/calls";
import { queryCallAnalysis } from "@voice-freight/backend/call-analysis";
import { queryDashboard, queryDashboardPage, queryDashboardVersion, queryCall } from "@voice-freight/backend/reporting";
import {
  checkLocalAuthentication,
  localIdentities,
  queryIdentity,
  signIn,
  signOut,
} from "@voice-freight/backend/identity";
import { restockInventory, seedDatabase } from "@voice-freight/backend/seeding";
import { BusinessError, requireCondition } from "@voice-freight/backend/model";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { ZodError, z } from "zod";
import { liveStartSchema } from "@voice-freight/contracts/live";
import {
  findLiveReservation,
  queryLiveStatus,
  queryTranscript,
  prepareBudgetFixture,
} from "@voice-freight/backend/live";
import { readState } from "@voice-freight/backend/repository";
import type { LiveBindings } from "./bindings";
export { ConfirmationProvider } from "./confirmation-provider";
export { AnalysisProvider } from "./analysis-provider";
export { LiveCall } from "./live-call";

// Runtime bindings also cover the supported local provider modes; generated
// configuration literals describe only the values in the selected environment.
type ApiEnvironment = { Bindings: LiveBindings; Variables: { user?: Identity } };
const app = new Hono<ApiEnvironment>();

app.use("/api/*", async (context, next): Promise<void> => {
  context.header("Cache-Control", "private, no-store");
  context.header("Vary", "Cookie");

  if (context.env.ENVIRONMENT !== "local") {
    requireCondition(
      context.env.AUTH_MODE === "access" && new URL(context.req.url).origin === context.env.PUBLIC_ORIGIN,
      "forbidden",
      "Use the public application origin.",
      403,
    );

    const user = await queryAccessIdentity(
      context.env.DB,
      context.req.header("Cf-Access-Jwt-Assertion") ?? getCookie(context, "CF_Authorization"),
      context.env,
    );

    context.set("user", user);
  }

  if (!["GET", "HEAD"].includes(context.req.method)) {
    const origin = context.req.header("origin");
    const origins = [new URL(context.req.url).origin];

    if (context.env.ENVIRONMENT === "local" && context.env.AUTH_MODE === "local") {
      if (origin && origin.startsWith("http://localhost")) {
        origins.push(origin);
      }
    }

    requireCondition(origin && origins.includes(origin), "invalid_origin", "A same-origin request is required.", 403);
  }

  await next();
});

app.onError((error, context): Response => {
  if (error instanceof ZodError || error instanceof SyntaxError) {
    return context.json(
      {
        error: { code: "invalid_input", message: "Request validation failed." },
      },
      400,
    );
  }

  if (error instanceof BusinessError) {
    return context.json({ error: { code: error.code, message: error.message } }, error.status);
  }

  return context.json(
    {
      error: {
        code: "unavailable",
        message: "Service unavailable. Check local migrations and retry.",
      },
    },
    503,
  );
});

async function resolveUser(context: Context<ApiEnvironment>): Promise<Identity> {
  const accessUser = context.get("user");
  if (accessUser) {
    return accessUser;
  }

  checkLocalAuthentication(context.env.ENVIRONMENT, context.env.AUTH_MODE);
  const user = await queryIdentity(context.env.DB, getCookie(context, "freight_session"));
  requireCondition(user, "unauthenticated", "Sign in to continue.", 401);
  return user;
}

app.get("/api/login", async (context): Promise<Response> => {
  await resolveUser(context);
  const destination = context.req.query("returnTo") ?? "/call";
  const url = new URL(destination, context.req.url);
  requireCondition(
    url.origin === new URL(context.req.url).origin &&
      ["/", "/call", "/dashboard", "/dashboard/call"].includes(url.pathname),
    "invalid_input",
    "Invalid return location.",
    400,
  );
  url.searchParams.set("account", "signed-in");
  return context.redirect(url.pathname + url.search, 303);
});

app.get("/api/identity", async (context): Promise<Response> => {
  if (context.env.ENVIRONMENT !== "local") {
    return context.json({ user: await resolveUser(context), identities: [] });
  }

  checkLocalAuthentication(context.env.ENVIRONMENT, context.env.AUTH_MODE);

  return context.json({
    user: await queryIdentity(context.env.DB, getCookie(context, "freight_session")),
    identities: localIdentities,
  });
});

app.post("/api/session", async (context): Promise<Response> => {
  checkLocalAuthentication(context.env.ENVIRONMENT, context.env.AUTH_MODE);
  const input = z.strictObject({ userId: z.string() }).parse(await context.req.json());
  await signOut(context.env.DB, getCookie(context, "freight_session"));
  const { user, session } = await signIn(context.env.DB, input.userId);

  setCookie(context, "freight_session", session.id, {
    httpOnly: true,
    sameSite: "Strict",
    secure: new URL(context.req.url).protocol === "https:",
    path: "/api",
    maxAge: 8 * 3600,
  });

  return context.json({ user });
});

app.delete("/api/session", async (context): Promise<Response> => {
  if (context.env.ENVIRONMENT !== "local") {
    await revokeAccessSession(
      context.env.DB,
      context.req.header("Cf-Access-Jwt-Assertion") ?? getCookie(context, "CF_Authorization"),
      context.env,
    );
    return context.json({ user: null });
  }

  checkLocalAuthentication(context.env.ENVIRONMENT, context.env.AUTH_MODE);
  await signOut(context.env.DB, getCookie(context, "freight_session"));
  deleteCookie(context, "freight_session", { path: "/api" });
  return context.json({ user: null });
});

app.get("/api/dashboard", async (context): Promise<Response> => {
  const user = await resolveUser(context);
  const page = context.req.query("page");

  if (page === undefined) {
    return context.json(await queryDashboard(context.env.DB, user.id));
  }

  const requestedPage = z.coerce.number().int().positive().parse(page);
  const samples = z
    .array(z.object({ id: z.string().min(1), startedAt: z.iso.datetime() }))
    .parse(JSON.parse(context.req.query("samples") ?? "[]"));
  return context.json(await queryDashboardPage(context.env.DB, user.id, requestedPage, samples));
});
app.get("/api/dashboard/status", async (context): Promise<Response> => {
  const ids = z.array(z.string().min(1)).parse(JSON.parse(context.req.query("ids") ?? "[]"));
  return context.json(await queryDashboardVersion(context.env.DB, (await resolveUser(context)).id, ids));
});
app.get("/api/calls", async (context): Promise<Response> =>
  context.json(await queryDashboard(context.env.DB, (await resolveUser(context)).id)),
);
app.get("/api/calls/:callId", async (context): Promise<Response> =>
  context.json(
    await queryCall(context.env.DB, {
      userId: (await resolveUser(context)).id,
      callId: context.req.param("callId"),
    }),
  ),
);
app.get("/api/calls/:callId/analysis", async (context): Promise<Response> =>
  context.json(
    await queryCallAnalysis(context.env.DB, {
      userId: (await resolveUser(context)).id,
      callId: context.req.param("callId"),
    }),
  ),
);
app.post("/api/calls/:callId/analysis/retry", async (context): Promise<Response> => {
  const user = await resolveUser(context);
  const input = z.strictObject({ version: z.number().int().positive() }).parse(await context.req.json());
  const callId = context.req.param("callId");

  const outcome = await context.env.CALLS.get(context.env.CALLS.idFromName(callId)).submitAnalysis({
    context: { userId: user.id, callId },
    action: "retry",
    version: input.version,
  });

  if ("error" in outcome) {
    throw new BusinessError(outcome.error.code, outcome.error.message, outcome.error.status);
  }

  return context.json(outcome.result, 202);
});
app.post("/api/calls", async (context): Promise<Response> => {
  const user = await resolveUser(context);
  z.strictObject({}).parse(await context.req.json());
  return context.json(await createCall(context.env.DB, user.id), 201);
});
app.post("/api/live/calls", async (context): Promise<Response> => {
  const user = await resolveUser(context);
  const input = liveStartSchema.parse(await context.req.json());

  if (context.env.ENVIRONMENT === "local" && context.env.VOICE_PROVIDER === "stub") {
    await prepareBudgetFixture(context.env.DB, context.env.VOICE_STUB_SCENARIO ?? "");
  }

  const previous = await findLiveReservation(context.env.DB, user.id, input.operationId);
  let id = previous?.id;

  if (!id) {
    const callId = crypto.randomUUID();

    const outcome = await context.env.CALLS.get(context.env.CALLS.idFromName(callId)).reserve(
      { callId, userId: user.id },
      input.operationId,
      new Date().toISOString(),
    );

    if ("error" in outcome) {
      throw new BusinessError(outcome.error.code, outcome.error.message, outcome.error.status);
    }

    id = outcome.result.id;
  }

  const callId = id;

  const result = await observeOperation({ callId, function: "call" }, () =>
    context.env.CALLS.get(context.env.CALLS.idFromName(callId)).start({ userId: user.id, callId }, input.offerSdp),
  );

  return context.json(result, 201);
});
app.get("/api/live/configuration", async (context): Promise<Response> => {
  await resolveUser(context);

  return context.json({
    provider: context.env.ENVIRONMENT === "local" && context.env.VOICE_PROVIDER === "stub" ? "stub" : "openai",
  });
});
app.get("/api/calls/:callId/live", async (context): Promise<Response> => {
  const user = await resolveUser(context);

  return context.json(
    await queryLiveStatus(context.env.DB, {
      userId: user.id,
      callId: context.req.param("callId"),
    }),
  );
});
app.get("/api/calls/:callId/transcript", async (context): Promise<Response> => {
  const user = await resolveUser(context);
  const input = context.req.query("after");
  const after =
    input === undefined
      ? undefined
      : z
          .string()
          .regex(/^(?:-1|0|[1-9]\d*)$/)
          .transform(Number)
          .pipe(z.number().int().safe().min(-1))
          .parse(input);

  return context.json(
    await queryTranscript(
      context.env.DB,
      {
        userId: user.id,
        callId: context.req.param("callId"),
      },
      after,
    ),
  );
});
app.post("/api/calls/:callId/connected", async (context): Promise<Response> => {
  const user = await resolveUser(context);
  z.strictObject({}).parse(await context.req.json());
  const callId = context.req.param("callId");
  await queryLiveStatus(context.env.DB, { userId: user.id, callId });
  await context.env.CALLS.get(context.env.CALLS.idFromName(callId)).connectAudio();
  return context.json({ id: callId });
});
app.post("/api/calls/:callId/hangup", async (context): Promise<Response> => {
  const user = await resolveUser(context);
  const input = z.strictObject({ interrupted: z.boolean().optional() }).parse(await context.req.json());
  const callId = context.req.param("callId");
  await queryLiveStatus(context.env.DB, { userId: user.id, callId });

  await context.env.CALLS.get(context.env.CALLS.idFromName(callId)).end(
    input.interrupted ? "Interrupted" : "Ended normally",
  );

  return context.json({ id: callId });
});
app.post("/api/calls/:callId/end", async (context): Promise<Response> => {
  const user = await resolveUser(context);
  const callId = context.req.param("callId");

  const outcome = await context.env.CALLS.get(context.env.CALLS.idFromName(callId)).submitAnalysis({
    context: { userId: user.id, callId },
    action: "finalize",
    input: finalizationSchema.parse(await context.req.json()),
    completedAt: new Date().toISOString(),
  });

  if ("error" in outcome) {
    throw new BusinessError(outcome.error.code, outcome.error.message, outcome.error.status);
  }

  return context.json(outcome.result);
});
app.post("/api/calls/:callId/tools/:name", async (context): Promise<Response> => {
  const user = await resolveUser(context);
  const { state } = await readState(context.env.DB);

  requireCondition(
    !state.liveSessions.some((entry): boolean => entry.id === context.req.param("callId")),
    "coordinator_required",
    "Live business actions belong to the voice coordinator.",
  );

  return context.json(
    await executeTool(
      context.env.DB,
      { userId: user.id, callId: context.req.param("callId") },
      toolNameSchema.parse(context.req.param("name")),
      invocationSchema.parse(await context.req.json()),
    ),
  );
});
app.post("/api/inventory/restock", async (context): Promise<Response> => {
  const user = await resolveUser(context);
  const input = z.strictObject({ operationId: z.string().uuid() }).parse(await context.req.json());
  return context.json(await restockInventory(context.env.DB, user.id, input.operationId));
});
app.post("/api/local/seed", async (context): Promise<Response> => {
  checkLocalAuthentication(context.env.ENVIRONMENT, context.env.AUTH_MODE);
  const user = await resolveUser(context);
  requireCondition(user.role === "administrator", "forbidden", "Administrator access required.", 403);
  return context.json(await seedDatabase(context.env.DB));
});

app.post("/api/local/limits/reset", async (context): Promise<Response> => {
  const user = await resolveUser(context);
  z.strictObject({}).parse(await context.req.json());
  return context.json(await resetDailyQuotas(context.env.DB, user.id, context.env));
});

app.post("/api/local/confirmations/evaluations", async (context): Promise<Response> => {
  requireCondition(context.env.ENVIRONMENT === "local", "forbidden", "Local evaluations only.", 403);
  const user = await resolveUser(context);
  const input = confirmationEvaluationSchema.parse(await context.req.json());
  return context.json(
    await evaluateConfirmation(context.env.DB, user.id, input, (evidence, id) =>
      classifyConfirmation(evidence, id, context.env),
    ),
  );
});

app.get("/api/health", async (context): Promise<Response> => {
  const status = statusSchema.parse({
    service: "api",
    database: await checkDatabase(context.env.DB),
  });

  const tools = statusSchema.parse(await context.env.TOOLS.getStatus());

  return context.json({ ...status, tools });
});

export default {
  fetch: app.fetch,
} satisfies ExportedHandler<LiveBindings>;
