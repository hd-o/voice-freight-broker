type AppBindings = {
  ASSETS: { fetch(request: Request): Promise<Response> };
  API?: { fetch(request: Request): Promise<Response> };
  AUTH_MODE?: string;
  PUBLIC_ORIGIN?: string;
};

export default {
  async fetch(request: Request, environment: AppBindings): Promise<Response> {
    const url = new URL(request.url);
    const access = environment.AUTH_MODE === "access";
    const privateHeaders = { "Cache-Control": "private, no-store", Vary: "Cookie, Cf-Access-Jwt-Assertion" };

    if (access && url.origin !== environment.PUBLIC_ORIGIN) {
      return new Response("Use the public application origin.", { status: 403, headers: privateHeaders });
    }

    if (url.pathname === "/auth/configuration") {
      if (!access || !environment.API) {
        return Response.json({ mode: access ? "access" : "local" }, { headers: privateHeaders });
      }

      const identityUrl = new URL("/api/identity", url);

      try {
        const identity = await environment.API.fetch(new Request(identityUrl, request));

        if (identity.status === 401) {
          return Response.json({ mode: "access", user: null }, { headers: privateHeaders });
        }

        if (identity.ok) {
          const data: { user: unknown } = await identity.json();
          return Response.json({ mode: "access", user: data.user }, { headers: privateHeaders });
        }
      } catch {
        // Identity is retried through its normal endpoint if bootstrap fails.
      }

      return Response.json({ mode: "access" }, { headers: privateHeaders });
    }

    if (url.pathname === "/auth/identity" && access) {
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
      if (!access || !environment.API) {
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
