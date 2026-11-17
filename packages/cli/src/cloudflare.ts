import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { join } from "node:path";
import { repositoryPath } from "./database.ts";
import { CommandError } from "./errors.ts";

export function loadEnvironment(): NodeJS.ProcessEnv {
  let values: Record<string, string | undefined> = {};

  try {
    values = parseEnv(readFileSync(join(repositoryPath, ".env"), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  return { ...values, ...process.env };
}

export async function requestCloudflare(
  path: string,
  options: { method?: string; body?: unknown; absence?: { status: number; code: number } } = {},
): Promise<unknown> {
  const environment = loadEnvironment();
  const token = environment.CLOUDFLARE_API_TOKEN;

  if (!token) {
    throw new CommandError(
      "cloudflare_credentials_missing",
      "Cloudflare API token is missing.",
      "Set CLOUDFLARE_API_TOKEN in the environment or .env.",
    );
  }

  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    method: options.method ?? "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    signal: AbortSignal.timeout(90_000),
  });

  const result = (await response.json()) as {
    success?: boolean;
    errors?: { code?: number; message?: string }[];
    result?: unknown;
  };

  if (!response.ok || !result.success) {
    if (
      options.absence &&
      response.status === options.absence.status &&
      result.errors?.length === 1 &&
      result.errors[0]?.code === options.absence.code
    ) {
      return null;
    }

    const secrets = [token, environment.OPENAI_API_KEY].filter((value): value is string => Boolean(value));
    const errors = result.errors
      ?.map(
        (error): string =>
          `${error.code ?? "unknown"}: ${secrets.reduce((message, secret): string => message.replaceAll(secret, "[redacted]"), error.message ?? "Cloudflare request failed")}`,
      )
      .join(", ");

    throw new CommandError(
      "cloudflare_request_failed",
      `Cloudflare request failed (${response.status})${errors ? `: ${errors}` : ""}.`,
      "Check the account, permissions, and resource configuration.",
    );
  }

  return result.result;
}
