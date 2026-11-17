import { WorkerEntrypoint } from "cloudflare:workers";

// API binds to this named entrypoint before the real Tools Worker can bind back
// to API's providers. Only a fresh installation needs this temporary version.
export class Tools extends WorkerEntrypoint {}

export default {
  fetch(): Response {
    return new Response("Tools installation is incomplete.", { status: 503 });
  },
};
