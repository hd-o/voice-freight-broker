type AppBindings = {
  ASSETS: { fetch(request: Request): Promise<Response> };
  API?: { fetch(request: Request): Promise<Response> };
  AUTH_MODE?: string;
  PUBLIC_ORIGIN?: string;
};

export default {
  async fetch(request: Request, environment: AppBindings): Promise<Response> {
    const url = new URL(request.url);
    const hosted = environment.AUTH_MODE === "access";
    const privateHeaders = { "Cache-Control": "private, no-store", Vary: "Cookie, Cf-Access-Jwt-Assertion" };

    if (hosted && url.origin !== environment.PUBLIC_ORIGIN) {
      return new Response("Use the public application origin.", { status: 403, headers: privateHeaders });
    }

    if (url.pathname === "/auth/configuration") {
      return Response.json({ mode: hosted ? "access" : "local" }, { headers: privateHeaders });
    }

    if (url.pathname === "/auth/identity" && hosted) {
      if (request.method !== "GET") {
        return new Response(null, { status: 405, headers: privateHeaders });
      }

      if (!environment.API) {
        return Response.json(
          { error: { code: "unavailable", message: "Account service unavailable." } },
          { status: 503, headers: privateHeaders },
        );
      }

      url.pathname = "/api/identity";
      url.search = "";
      const identity = await environment.API.fetch(new Request(url, request));

      if (identity.status === 401) {
        return Response.json({ user: null, identities: [] }, { headers: privateHeaders });
      }

      return new Response(identity.body, { status: identity.status, headers: privateHeaders });
    }

    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      if (!hosted || !environment.API) {
        return Response.json(
          { error: { code: "unavailable", message: "API unavailable." } },
          { status: 503, headers: privateHeaders },
        );
      }

      return environment.API.fetch(request);
    }

    return environment.ASSETS.fetch(request);
  },
};
