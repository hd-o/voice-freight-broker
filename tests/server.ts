import { createServer, request as requestHttp } from "node:http";
import { arrayBuffer as readBody } from "node:stream/consumers";
import type { Socket } from "node:net";
import type { TestHarness } from "wrangler";

export async function createBrowserServer(
  backend: TestHarness,
  frontendURL: string,
): Promise<{ url: string; close(): Promise<void> }> {
  const sockets = new Set<Socket>();

  const server = createServer((request, response): void => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host}`);

    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      void forwardApi().catch((error: unknown): void => {
        console.error("Browser test API proxy failed", error);
        response.writeHead(502);
        response.end("Browser test API unavailable");
      });

      return;
    }

    const upstream = requestHttp(
      new URL(request.url ?? "/", frontendURL),
      { method: request.method, headers: request.headers },
      (incoming): void => {
        response.writeHead(incoming.statusCode ?? 502, incoming.headers);
        incoming.on("error", (error): ReturnType<typeof response.destroy> => response.destroy(error));
        incoming.pipe(response);
      },
    );

    upstream.on("error", (error): ReturnType<typeof response.destroy> => response.destroy(error));
    response.on("close", (): ReturnType<typeof upstream.destroy> => upstream.destroy());
    request.pipe(upstream);

    async function forwardApi(): Promise<void> {
      const headers = new Headers();

      for (const [name, value] of Object.entries(request.headers)) {
        if (value !== undefined) {
          headers.set(name, Array.isArray(value) ? value.join(", ") : value);
        }
      }

      // Preserve the browser origin for the API's same-origin checks and cookies.
      const incoming = await backend.fetch(url.href, {
        method: request.method,
        headers: Array.from(headers),
        body: request.method === "GET" || request.method === "HEAD" ? undefined : await readBody(request),
      });

      for (const [name, value] of incoming.headers) {
        if (name !== "set-cookie") {
          response.setHeader(name, value);
        }
      }

      const cookies = incoming.headers.getSetCookie();

      if (cookies.length) {
        response.setHeader("set-cookie", cookies);
      }

      response.writeHead(incoming.status);
      response.end(Buffer.from(await incoming.arrayBuffer()));
    }
  });

  server.on("connection", (socket): void => {
    sockets.add(socket);
    socket.on("close", (): boolean => sockets.delete(socket));
  });

  // Keep the shared vinext server's HMR connection working on the proxy origin.
  server.on("upgrade", (request, socket, head): void => {
    const upstream = requestHttp(new URL(request.url ?? "/", frontendURL), {
      headers: request.headers,
    });

    upstream.on("upgrade", (incoming, connection, data): void => {
      socket.write("HTTP/1.1 101 Switching Protocols\r\n");

      for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
        socket.write(`${incoming.rawHeaders[index]}: ${incoming.rawHeaders[index + 1]}\r\n`);
      }

      socket.write("\r\n");

      if (data.length) {
        socket.write(data);
      }

      if (head.length) {
        connection.write(head);
      }

      socket.on("error", (): ReturnType<typeof connection.destroy> => connection.destroy());
      connection.on("error", (): ReturnType<typeof socket.destroy> => socket.destroy());
      socket.on("close", (): ReturnType<typeof connection.destroy> => connection.destroy());
      socket.pipe(connection).pipe(socket);
    });

    upstream.on("error", (): ReturnType<typeof socket.destroy> => socket.destroy());
    upstream.on("response", (): ReturnType<typeof socket.destroy> => socket.destroy());
    socket.on("close", (): ReturnType<typeof upstream.destroy> => upstream.destroy());
    upstream.end();
  });

  await new Promise<void>((resolve, reject): void => {
    server.once("error", reject);

    server.listen(0, "127.0.0.1", (): void => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();

  if (!address || typeof address === "string") {
    throw new Error("Browser test server did not bind a TCP port");
  }

  return {
    url: `http://127.0.0.1:${address.port}`,
    async close(): Promise<void> {
      for (const socket of sockets) {
        socket.destroy();
      }

      await new Promise<void>((resolve, reject): void => {
        server.close((error): void => (error ? reject(error) : resolve()));
      });
    },
  };
}
