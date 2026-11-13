import { Hono } from "hono";
import { checkDatabase } from "@voice-freight/backend";
import { statusSchema } from "@voice-freight/contracts";

const app = new Hono<{ Bindings: Env }>();

app.get("/api/health", async (context) => {
  const status = statusSchema.parse({
    service: "api",
    database: await checkDatabase(context.env.DB),
  });
  const tools = statusSchema.parse(await context.env.TOOLS.getStatus());
  return context.json({ ...status, tools });
});

export default app;
