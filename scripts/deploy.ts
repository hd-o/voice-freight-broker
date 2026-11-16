// Provision and deploy the three Workers from one checkout, with a separate
// hosted database and allowance. Local data and provider usage stay untouched.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir, cp } from "node:fs/promises";
import { build } from "esbuild";
import { resolve } from "node:path";
import { parseEnv, parseArgs } from "node:util";
import { parse, type ParseError } from "jsonc-parser";
import { z } from "zod";

const root = resolve(import.meta.dirname, "..");
const { values } = parseArgs({ options: { prepare: { type: "boolean" }, help: { type: "boolean" } } });

if (values.help) {
  console.log(
    "pnpm deploy:hosted [--prepare]\n--prepare provisions resources and configuration without deploying Workers.",
  );
  process.exit(0);
}

// Read credentials privately; child processes receive them through environment.
const configuration = { ...parseEnv(await readFile(resolve(root, ".env"), "utf8")), ...process.env };
const accountId = configuration.CLOUDFLARE_ACCOUNT_ID;
const token = configuration.CLOUDFLARE_API_TOKEN;

if (!accountId || !token) {
  throw new Error("Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN in the ignored root .env.");
}

const origin = "https://voice-freight-app.hadrian-dev.workers.dev";
const emailList = z.array(
  z
    .string()
    .trim()
    .email()
    .transform((email): string => email.toLowerCase()),
);
const administrators = emailList.min(1).parse(configuration.HOSTED_ADMINISTRATORS?.split(","));
const reviewers = emailList.parse(configuration.HOSTED_REVIEWERS?.split(",") ?? []);
const apiRoot = `https://api.cloudflare.com/client/v4/accounts/${accountId}`;

type Resource = {
  id?: string;
  uuid?: string;
  queue_id?: string;
  name?: string;
  queue_name?: string;
  type?: string;
  auth_domain?: string;
  aud?: string;
  domain?: string;
};

async function requestCloudflare(path: string, method = "GET", body?: unknown): Promise<Resource[]> {
  const response = await fetch(`${apiRoot}/${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const data = (await response.json()) as {
    success: boolean;
    result: Resource | Resource[];
    errors?: { message: string }[];
  };

  if (!response.ok || !data.success) {
    throw new Error(
      `Cloudflare ${method} ${path}: ${response.status} ${data.errors?.map((error): string => error.message).join("; ") ?? "request failed"}`,
    );
  }

  return Array.isArray(data.result) ? data.result : [data.result];
}

async function runCommand(command: string, argumentsData: string[], input?: string): Promise<void> {
  await new Promise<void>((resolve, reject): void => {
    const child = spawn(command, argumentsData, {
      cwd: root,
      env: configuration,
      stdio: [input === undefined ? "ignore" : "pipe", "inherit", "inherit"],
    });
    child.on("error", reject);
    child.on("exit", (code): void =>
      code === 0 ? resolve() : reject(new Error(`${command} ${argumentsData[0]} failed (${code}).`)),
    );

    if (input !== undefined) {
      child.stdin?.end(input);
    }
  });
}

// A digest records the exact deployed source, including reviewed uncommitted work.
async function calculateSourceDigest(): Promise<string> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execution = promisify(execFile);
  const { stdout } = await execution("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { cwd: root });
  const digest = createHash("sha256");

  for (const path of stdout.trim().split("\n").sort()) {
    if (!path || path.endsWith("worker-configuration.d.ts")) {
      continue;
    }
    digest.update(path).update(await readFile(resolve(root, path)));
  }

  return digest.digest("hex");
}

// Reuse named resources so repeat deployments preserve inventory and spending.
const [organization] = await requestCloudflare("access/organizations");

if (!organization.auth_domain) {
  throw new Error("Complete Cloudflare Zero Trust onboarding before deployment.");
}

let database = (await requestCloudflare("d1/database")).find((entry): boolean => entry.name === "voice-freight-hosted");

if (!database) {
  [database] = await requestCloudflare("d1/database", "POST", { name: "voice-freight-hosted" });
}

const databaseId = database.uuid;

if (!databaseId) {
  throw new Error("Cloudflare returned no D1 database ID.");
}

for (const name of ["voice-freight-analysis", "voice-freight-analysis-dead-letter"]) {
  const queues = await requestCloudflare("queues");

  if (!queues.some((entry): boolean => entry.queue_name === name)) {
    await requestCloudflare("queues", "POST", { queue_name: name });
  }
}

// Restrict Access to approved emails and the API path, leaving samples public.
let provider = (await requestCloudflare("access/identity_providers")).find(
  (entry): boolean => entry.type === "onetimepin",
);

if (!provider) {
  [provider] = await requestCloudflare("access/identity_providers", "POST", {
    name: "Demo email code",
    type: "onetimepin",
    config: {},
  });
}

const applicationDomain = `${new URL(origin).hostname}/api`;
let application = (await requestCloudflare("access/apps")).find((entry): boolean => entry.domain === applicationDomain);
const applicationBody = {
  name: "Voice Freight Broker API",
  type: "self_hosted",
  domain: applicationDomain,
  session_duration: "8h",
  allowed_idps: [provider.id],
  auto_redirect_to_identity: true,
  app_launcher_visible: false,
  http_only_cookie_attribute: true,
  same_site_cookie_attribute: "lax",
};

[application] = await requestCloudflare(
  application ? `access/apps/${application.id}` : "access/apps",
  application ? "PUT" : "POST",
  applicationBody,
);

const policies = await requestCloudflare(`access/apps/${application.id}/policies`);
const policy = policies.find((entry): boolean => entry.name === "Invited demo users");
await requestCloudflare(
  policy ? `access/apps/${application.id}/policies/${policy.id}` : `access/apps/${application.id}/policies`,
  policy ? "PUT" : "POST",
  {
    name: "Invited demo users",
    decision: "allow",
    precedence: 1,
    include: [...administrators, ...reviewers].map((email): { email: { email: string } } => ({ email: { email } })),
  },
);

if (!application.aud) {
  throw new Error("Cloudflare returned no Access audience.");
}

// Set only top-level hosted bindings; local and stub environments retain theirs.
const workerConfigurationSchema = z
  .object({
    d1_databases: z.array(
      z.object({ binding: z.string(), database_name: z.string(), database_id: z.string() }).passthrough(),
    ),
    vars: z.record(z.string(), z.string()).optional(),
  })
  .passthrough();

for (const path of ["apps/api/wrangler.jsonc", "apps/tools/wrangler.jsonc"]) {
  const location = resolve(root, path);
  const source = await readFile(location, "utf8");
  const errors: ParseError[] = [];
  const document: unknown = parse(source, errors, { allowTrailingComma: true });

  if (errors.length) {
    throw new Error(`Cannot parse ${path}.`);
  }

  const workerConfiguration = workerConfigurationSchema.parse(document);
  const binding = workerConfiguration.d1_databases.find((entry): boolean => entry.binding === "DB");

  if (!binding) {
    throw new Error(`${path} has no DB binding.`);
  }

  binding.database_name = "voice-freight-hosted";
  binding.database_id = databaseId;

  if (path.includes("api/")) {
    workerConfiguration.vars = {
      ...workerConfiguration.vars,
      ENVIRONMENT: "hosted",
      AUTH_MODE: "access",
      PUBLIC_ORIGIN: origin,
      ACCESS_ISSUER: `https://${organization.auth_domain}`,
      ACCESS_AUDIENCE: application.aud,
    };
  }

  await writeFile(location, JSON.stringify(workerConfiguration, null, 2) + "\n");
}

// Keep generated configuration in repository format before capturing its digest.
await runCommand("pnpm", ["exec", "vp", "fmt", "apps/api/wrangler.jsonc", "apps/tools/wrangler.jsonc"]);

await mkdir(resolve(root, ".local"), { recursive: true });
await writeFile(
  resolve(root, ".local/hosting.json"),
  JSON.stringify(
    {
      origin,
      databaseId,
      accessApplicationId: application.id,
      issuer: `https://${organization.auth_domain}`,
      audience: application.aud,
      administrators,
      reviewers,
    },
    null,
    2,
  ) + "\n",
);
console.log(`Hosted resources ready: ${origin}. Local databases and allowances are unchanged.`);

if (values.prepare) {
  process.exit(0);
}

// Capture source before verification, so changes during checks cannot be published.
const { execFile } = await import("node:child_process");
const { promisify } = await import("node:util");
const { stdout: revision } = await promisify(execFile)("git", ["rev-parse", "HEAD"], { cwd: root });
const digest = await calculateSourceDigest();
const credentials = parseEnv(await readFile(resolve(root, "apps/api/.dev.vars.local"), "utf8"));

if (!credentials.OPENAI_API_KEY) {
  throw new Error("The authorized local OpenAI key is missing.");
}

await runCommand("pnpm", ["typecheck"]);
await runCommand("pnpm", ["exec", "vp", "check", "--no-fmt"]);
await runCommand("pnpm", ["test"]);
await runCommand("pnpm", ["build"]);
await runCommand("pnpm", ["build:storybook"]);
await runCommand("pnpm", ["test:browser"]);

if (digest !== (await calculateSourceDigest())) {
  throw new Error("Source changed during validation. Nothing has been deployed; rerun from a stable checkout.");
}

// Copy immutable bundles, assets and migrations. Publication never rebuilds source.
const release = resolve(root, ".local/releases", crypto.randomUUID());
await mkdir(release, { recursive: true });
await cp(resolve(root, "apps/api/dist"), resolve(release, "api"), { recursive: true });
await cp(resolve(root, "apps/tools/dist"), resolve(release, "tools"), { recursive: true });
await cp(resolve(root, "apps/web/dist/client"), resolve(release, "assets"), { recursive: true });
await cp(resolve(root, "packages/backend/migrations"), resolve(release, "migrations"), { recursive: true });
await build({
  entryPoints: [resolve(root, "apps/web/deploy/worker.ts")],
  outfile: resolve(release, "app/worker.js"),
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2023",
});
const artifacts = new Map<string, string>();

for (const [name, path] of [
  ["api", "apps/api/wrangler.jsonc"],
  ["tools", "apps/tools/wrangler.jsonc"],
  ["app", "apps/web/deploy/wrangler.jsonc"],
]) {
  const document: unknown = parse(await readFile(resolve(root, path), "utf8"));
  const workerConfiguration = z.record(z.string(), z.unknown()).parse(document);
  const destination = resolve(release, `${name}.json`);
  const databaseBindings =
    name === "app"
      ? undefined
      : workerConfigurationSchema
          .parse(document)
          .d1_databases.map((binding) => ({ ...binding, migrations_dir: "migrations" }));
  await writeFile(
    destination,
    JSON.stringify(
      {
        ...workerConfiguration,
        env: undefined,
        main: `${name}/worker.js`,
        d1_databases: databaseBindings,
        ...(name === "app"
          ? { assets: { ...z.record(z.string(), z.unknown()).parse(workerConfiguration.assets), directory: "assets" } }
          : {}),
      },
      null,
      2,
    ),
  );
  artifacts.set(name, destination);
}

if (digest !== (await calculateSourceDigest())) {
  throw new Error("Source changed while freezing the release. Nothing has been deployed.");
}

const apiConfiguration = artifacts.get("api");
const toolsConfiguration = artifacts.get("tools");
const appConfiguration = artifacts.get("app");

if (!apiConfiguration || !toolsConfiguration || !appConfiguration) {
  throw new Error("Release configurations are incomplete.");
}

await runCommand("pnpm", [
  "exec",
  "wrangler",
  "d1",
  "migrations",
  "apply",
  "DB",
  "--remote",
  "--config",
  apiConfiguration,
]);

// Provision roles in D1 independently of model arguments or Access email headers.
const identities = [
  ...administrators.map((email): { id: string; name: string; role: string } => ({
    id: `access:${email}`,
    name: email,
    role: "administrator",
  })),
  ...reviewers.map((email): { id: string; name: string; role: string } => ({
    id: `access:${email}`,
    name: email,
    role: "reviewer",
  })),
];
const statements = identities
  .map(
    (identity): string =>
      `INSERT INTO users (id, data) VALUES ('${identity.id.replaceAll("'", "''")}', '${JSON.stringify(identity).replaceAll("'", "''")}') ON CONFLICT(id) DO UPDATE SET data=excluded.data;`,
  )
  .join("\n");
await writeFile(
  resolve(root, ".local/hosted-roles.sql"),
  statements + "\nUPDATE revision SET version=version+1 WHERE id=1;\n",
);
await runCommand("pnpm", [
  "exec",
  "wrangler",
  "d1",
  "execute",
  "DB",
  "--remote",
  "--config",
  apiConfiguration,
  "--file",
  ".local/hosted-roles.sql",
]);

// Break the initial circular service-binding dependency with a private stub.
const workers = await requestCloudflare("workers/scripts");

if (!workers.some((entry): boolean => entry.id === "voice-freight-tools")) {
  await writeFile(
    resolve(root, ".local/bootstrap.ts"),
    'import { WorkerEntrypoint } from "cloudflare:workers";\nexport class Tools extends WorkerEntrypoint {}\nexport default { fetch() { return new Response(null, { status: 503 }); } };\n',
  );
  await writeFile(
    resolve(root, ".local/bootstrap.json"),
    JSON.stringify({
      name: "voice-freight-tools",
      main: "bootstrap.ts",
      compatibility_date: "2026-11-12",
      workers_dev: false,
      preview_urls: false,
    }),
  );
  await runCommand("pnpm", ["exec", "wrangler", "deploy", "--config", ".local/bootstrap.json"]);
}

// Deploy the frozen provider entrypoints before Tools, then expose the app last.
await runCommand("pnpm", ["exec", "wrangler", "deploy", "--no-bundle", "--config", apiConfiguration]);
await runCommand(
  "pnpm",
  ["exec", "wrangler", "secret", "put", "OPENAI_API_KEY", "--config", apiConfiguration],
  credentials.OPENAI_API_KEY,
);
await runCommand("pnpm", ["exec", "wrangler", "deploy", "--no-bundle", "--config", toolsConfiguration]);
await runCommand("pnpm", ["exec", "wrangler", "deploy", "--no-bundle", "--config", appConfiguration]);

await writeFile(
  resolve(root, ".local/deployment.json"),
  JSON.stringify(
    { origin, release, sourceRevision: revision.trim(), sourceDigest: digest, deployedAt: new Date().toISOString() },
    null,
    2,
  ) + "\n",
);
console.log(`Deployed ${origin}. Hosted and local each retain their own $25 monthly allowance.`);
