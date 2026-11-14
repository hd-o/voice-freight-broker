import { Hono } from "hono";
import { checkDatabase } from "@voice-freight/backend";
import { statusSchema } from "@voice-freight/contracts";
import { toolNameSchema, invocationSchema, finalizationSchema } from "@voice-freight/contracts/business";
import { executeTool } from "@voice-freight/backend/business";
import { createCall, finalizeCall } from "@voice-freight/backend/calls";
import { queryDashboard, queryCall } from "@voice-freight/backend/reporting";
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
import { reserveLiveCall, queryLiveStatus, prepareBudgetFixture } from "@voice-freight/backend/live";
import { readState } from "@voice-freight/backend/repository";
import { resolveUsageLimits } from "@voice-freight/backend/spending";
import type { LiveBindings } from "./bindings";
export { LiveCall } from "./live-call";

const app = new Hono<{ Bindings: Env & LiveBindings }>();

app.use("/api/*", async (context, next) => {
  context.header("Cache-Control", "private, no-store");
  context.header("Vary", "Cookie");
  if (!["GET", "HEAD"].includes(context.req.method)) {
    const origin = context.req.header("origin");
    const origins = [new URL(context.req.url).origin];
    if (context.env.ENVIRONMENT === "local" && context.env.AUTH_MODE === "local") {
      origins.push("http://localhost:3000", "http://127.0.0.1:3000");
      if (context.env.LOCAL_ALLOWED_ORIGIN) {
        origins.push(context.env.LOCAL_ALLOWED_ORIGIN);
      }
    }
    requireCondition(origin && origins.includes(origin), "invalid_origin", "A same-origin request is required.", 403);
  }
  await next();
});

app.onError((error, context) => {
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

async function resolveUser(context: import("hono").Context<{ Bindings: Env & LiveBindings }>) {
  checkLocalAuthentication(context.env.ENVIRONMENT, context.env.AUTH_MODE);
  const user = await queryIdentity(context.env.DB, getCookie(context, "freight_session"));
  requireCondition(user, "unauthenticated", "Sign in to continue.", 401);
  return user;
}

app.get("/api/identity", async (context) => {
  checkLocalAuthentication(context.env.ENVIRONMENT, context.env.AUTH_MODE);
  return context.json({
    user: await queryIdentity(context.env.DB, getCookie(context, "freight_session")),
    identities: localIdentities,
  });
});

app.post("/api/session", async (context) => {
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

app.delete("/api/session", async (context) => {
  checkLocalAuthentication(context.env.ENVIRONMENT, context.env.AUTH_MODE);
  await signOut(context.env.DB, getCookie(context, "freight_session"));
  deleteCookie(context, "freight_session", { path: "/api" });
  return context.json({ user: null });
});

app.get("/api/dashboard", async (context) =>
  context.json(await queryDashboard(context.env.DB, (await resolveUser(context)).id)),
);
app.get("/api/calls", async (context) =>
  context.json(await queryDashboard(context.env.DB, (await resolveUser(context)).id)),
);
app.get("/api/calls/:callId", async (context) =>
  context.json(
    await queryCall(context.env.DB, {
      userId: (await resolveUser(context)).id,
      callId: context.req.param("callId"),
    }),
  ),
);
app.post("/api/calls", async (context) => {
  const user = await resolveUser(context);
  z.strictObject({}).parse(await context.req.json());
  return context.json(await createCall(context.env.DB, user.id), 201);
});
app.post("/api/live/calls", async (context) => {
  const user = await resolveUser(context);
  const input = liveStartSchema.parse(await context.req.json());
  if (context.env.ENVIRONMENT === "local" && context.env.VOICE_PROVIDER === "stub") {
    await prepareBudgetFixture(context.env.DB, context.env.VOICE_STUB_SCENARIO ?? "");
  }
  const { id } = await reserveLiveCall(
    context.env.DB,
    user.id,
    input.operationId,
    new Date().toISOString(),
    resolveUsageLimits(context.env),
  );
  const result = await context.env.CALLS.get(context.env.CALLS.idFromName(id)).start(
    { userId: user.id, callId: id },
    input.offerSdp,
  );
  return context.json(result, 201);
});
app.get("/api/live/configuration", async (context) => {
  await resolveUser(context);
  return context.json({
    provider: context.env.ENVIRONMENT === "local" && context.env.VOICE_PROVIDER === "stub" ? "stub" : "openai",
  });
});
app.get("/api/calls/:callId/live", async (context) => {
  const user = await resolveUser(context);
  return context.json(
    await queryLiveStatus(context.env.DB, {
      userId: user.id,
      callId: context.req.param("callId"),
    }),
  );
});
app.post("/api/calls/:callId/connected", async (context) => {
  const user = await resolveUser(context);
  z.strictObject({}).parse(await context.req.json());
  const callId = context.req.param("callId");
  await queryLiveStatus(context.env.DB, { userId: user.id, callId });
  await context.env.CALLS.get(context.env.CALLS.idFromName(callId)).connectAudio();
  return context.json({ id: callId });
});
app.post("/api/calls/:callId/hangup", async (context) => {
  const user = await resolveUser(context);
  const input = z.strictObject({ interrupted: z.boolean().optional() }).parse(await context.req.json());
  const callId = context.req.param("callId");
  await queryLiveStatus(context.env.DB, { userId: user.id, callId });
  await context.env.CALLS.get(context.env.CALLS.idFromName(callId)).end(
    input.interrupted ? "Interrupted" : "Ended normally",
  );
  return context.json({ id: callId });
});
app.post("/api/calls/:callId/end", async (context) => {
  const user = await resolveUser(context);
  const { state } = await readState(context.env.DB);
  requireCondition(
    !state.liveSessions.some((entry) => entry.id === context.req.param("callId")),
    "coordinator_required",
    "Use the live call hang-up action.",
  );
  return context.json(
    await finalizeCall(
      context.env.DB,
      { userId: user.id, callId: context.req.param("callId") },
      finalizationSchema.parse(await context.req.json()),
    ),
  );
});
app.post("/api/calls/:callId/tools/:name", async (context) => {
  const user = await resolveUser(context);
  const { state } = await readState(context.env.DB);
  requireCondition(
    !state.liveSessions.some((entry) => entry.id === context.req.param("callId")),
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
app.post("/api/inventory/restock", async (context) => {
  const user = await resolveUser(context);
  const input = z.strictObject({ operationId: z.string().uuid() }).parse(await context.req.json());
  return context.json(await restockInventory(context.env.DB, user.id, input.operationId));
});
app.post("/api/local/seed", async (context) => {
  const user = await resolveUser(context);
  requireCondition(user.role === "administrator", "forbidden", "Administrator access required.", 403);
  return context.json(await seedDatabase(context.env.DB));
});

app.get("/api/health", async (context) => {
  const status = statusSchema.parse({
    service: "api",
    database: await checkDatabase(context.env.DB),
  });
  const tools = statusSchema.parse(await context.env.TOOLS.getStatus());

  return context.json({ ...status, tools });
});

export default app;
