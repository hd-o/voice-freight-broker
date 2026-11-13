import { WorkerEntrypoint } from "cloudflare:workers";
import { checkDatabase } from "@voice-freight/backend";
import { statusSchema } from "@voice-freight/contracts";

export class Tools extends WorkerEntrypoint<Env> {
  async getStatus() {
    return statusSchema.parse({
      service: "tools",
      database: await checkDatabase(this.env.DB),
    });
  }
}

export default {
  fetch() {
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
