// Prepare hosted configuration and release metadata for the Bash deployment workflow.
// JSONC and SQL stay in TypeScript so shell scripts never interpolate structured data.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs, promisify } from "node:util";
import { parse, type ParseError } from "jsonc-parser";
import { z } from "zod";

const root = resolve(import.meta.dirname, "..");
const { values } = parseArgs({
  options: {
    digest: { type: "boolean" },
    release: { type: "string" },
    bootstrap: { type: "string" },
  },
});

// A digest records the exact deployed source, including reviewed uncommitted work.
async function calculateSourceDigest(): Promise<string> {
  const execution = promisify(execFile);
  const { stdout } = await execution("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd: root,
  });
  const digest = createHash("sha256");

  for (const path of stdout.split("\0").sort()) {
    if (!path || path.endsWith("worker-configuration.d.ts")) {
      continue;
    }
    const contents = await readFile(resolve(root, path)).catch((error: NodeJS.ErrnoException): null => {
      if (error.code !== "ENOENT") {
        throw error;
      }
      return null;
    });

    digest
      .update(path)
      .update("\0")
      .update(contents === null ? "deleted\0" : "file\0");

    if (contents !== null) {
      digest.update(contents);
    }
  }

  return digest.digest("hex");
}

if (values.digest) {
  console.log(await calculateSourceDigest());
  process.exit(0);
}

// Validate the inventory response before deciding whether the first-install stub is needed.
if (values.bootstrap) {
  const directory = resolve(values.bootstrap);
  const workers = z
    .object({ success: z.literal(true), result: z.array(z.object({ id: z.string() })) })
    .parse(JSON.parse(await readFile(resolve(directory, "workers.json"), "utf8"))).result;
  const configuration = z
    .object({ name: z.string() })
    .parse(JSON.parse(await readFile(resolve(directory, "tools.json"), "utf8")));
  console.log(!workers.some((worker): boolean => worker.id === configuration.name));
  process.exit(0);
}

// Freeze generated configuration alongside the bundles copied by Bash.
if (values.release) {
  const directory = resolve(values.release);

  for (const name of ["api", "tools", "app"]) {
    const worker = z
      .record(z.string(), z.unknown())
      .parse(JSON.parse(await readFile(resolve(root, `.local/wrangler/${name}.json`), "utf8")));
    const configuration = {
      ...worker,
      main: `${name}/worker.js`,
      ...(name === "app"
        ? {
            assets: { ...z.record(z.string(), z.unknown()).parse(worker.assets), directory: "assets" },
          }
        : {
            d1_databases: z
              .array(z.object({ migrations_dir: z.string() }).passthrough())
              .parse(worker.d1_databases)
              .map((binding) => ({ ...binding, migrations_dir: "migrations" })),
          }),
    };
    await writeFile(resolve(directory, `${name}.json`), JSON.stringify(configuration, null, 2) + "\n");
  }

  const { stdout: revision } = await promisify(execFile)("git", ["rev-parse", "HEAD"], { cwd: root });
  const hosting = z
    .object({ origin: z.string().url() })
    .parse(JSON.parse(await readFile(resolve(root, ".local/wrangler/hosting.json"), "utf8")));
  await writeFile(
    resolve(directory, "deployment.json"),
    JSON.stringify(
      {
        origin: hosting.origin,
        release: directory,
        sourceRevision: revision.trim(),
        sourceDigest: await calculateSourceDigest(),
      },
      null,
      2,
    ) + "\n",
  );
  process.exit(0);
}

const emailList = z.array(
  z
    .string()
    .trim()
    .email()
    .transform((email): string => email.toLowerCase()),
);
const hosting = z
  .object({
    accountId: z.string().regex(/^[a-f0-9]{32}$/),
    origin: z.string().url(),
    databaseId: z.string().uuid(),
    databaseName: z.string(),
    issuer: z.string().url(),
    audience: z.string().min(1),
    administrators: emailList.min(1),
    reviewers: emailList,
    prefix: z.string().regex(/^[a-z][a-z0-9-]*$/),
  })
  .parse(JSON.parse(await readFile(resolve(root, ".local/wrangler/hosting.json"), "utf8")));
const { accountId, origin, administrators, reviewers } = hosting;
const databaseId = hosting.databaseId;

// Set only top-level hosted bindings; the local environment retains its own.
const workerConfigurationSchema = z
  .object({
    d1_databases: z.array(
      z.object({ binding: z.string(), database_name: z.string(), database_id: z.string() }).passthrough(),
    ),
    vars: z.record(z.string(), z.string()).optional(),
  })
  .passthrough();

// Generate operator configurations without rewriting the checked-in templates.
await mkdir(resolve(root, ".local/wrangler"), { recursive: true });

for (const [name, path] of [
  ["api", "apps/api/wrangler.jsonc"],
  ["tools", "apps/tools/wrangler.jsonc"],
  ["app", "apps/web/deploy/wrangler.jsonc"],
]) {
  const errors: ParseError[] = [];
  const document: unknown = parse(await readFile(resolve(root, path), "utf8"), errors, { allowTrailingComma: true });
  if (errors.length) {
    throw new Error(`Cannot parse ${path}.`);
  }
  const worker = z.record(z.string(), z.unknown()).parse(document);
  const variables = z.record(z.string(), z.string()).parse(worker.vars ?? {});
  const services = z
    .array(z.object({ service: z.string() }).passthrough())
    .parse(worker.services)
    .map((service) => ({
      ...service,
      service: service.service.replace(/^voice-freight-/, `${hosting.prefix}-`),
    }));
  const queues =
    name === "tools"
      ? z
          .object({
            producers: z.array(z.object({ queue: z.string() }).passthrough()),
            consumers: z.array(z.object({ queue: z.string(), dead_letter_queue: z.string().optional() }).passthrough()),
          })
          .parse(worker.queues)
      : undefined;

  const documentConfiguration = {
    ...worker,
    $schema: undefined,
    env: undefined,
    name: `${hosting.prefix}-${name}`,
    account_id: accountId,
    main: resolve(root, name === "app" ? "apps/web/deploy/worker.ts" : `apps/${name}/src/worker.ts`),
    services,
    ...(name === "app" && !new URL(origin).hostname.endsWith(".workers.dev")
      ? {
          workers_dev: false,
          routes: [{ pattern: new URL(origin).hostname, custom_domain: true }],
        }
      : {}),
    vars: {
      ...variables,
      ...(name === "tools" ? {} : { PUBLIC_ORIGIN: origin }),
      ...(name === "api" ? { ACCESS_ISSUER: hosting.issuer, ACCESS_AUDIENCE: hosting.audience } : {}),
    },
    ...(name === "app"
      ? {
          assets: {
            ...z.record(z.string(), z.unknown()).parse(worker.assets),
            directory: resolve(root, "apps/web/dist/client"),
          },
        }
      : {
          d1_databases: workerConfigurationSchema.parse(worker).d1_databases.map((binding) => ({
            ...binding,
            database_name: hosting.databaseName,
            database_id: databaseId,
            migrations_dir: resolve(root, "packages/backend/migrations"),
          })),
        }),
    ...(queues
      ? {
          queues: {
            producers: queues.producers.map((producer) => ({
              ...producer,
              queue: producer.queue.replace(/^voice-freight-/, `${hosting.prefix}-`),
            })),
            consumers: queues.consumers.map((consumer) => ({
              ...consumer,
              queue: consumer.queue.replace(/^voice-freight-/, `${hosting.prefix}-`),
              dead_letter_queue: consumer.dead_letter_queue?.replace(/^voice-freight-/, `${hosting.prefix}-`),
            })),
          },
        }
      : {}),
  };
  await writeFile(resolve(root, `.local/wrangler/${name}.json`), JSON.stringify(documentConfiguration, null, 2) + "\n");
}

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
const identitiesList = identities.map((identity): string => `'${identity.id.replaceAll("'", "''")}'`).join(",");

await writeFile(
  resolve(root, ".local/hosted-roles.sql"),
  `DELETE FROM users WHERE id LIKE 'access:%' AND id NOT IN (${identitiesList});\n` +
    statements +
    "\nUPDATE revision SET version=version+1 WHERE id=1;\n",
);

// The private stub resolves the circular service dependency on the first release only.
const tools = z
  .object({ compatibility_date: z.string(), compatibility_flags: z.array(z.string()).optional() })
  .parse(parse(await readFile(resolve(root, "apps/tools/wrangler.jsonc"), "utf8")));
await writeFile(
  resolve(root, ".local/wrangler/bootstrap.ts"),
  'import { WorkerEntrypoint } from "cloudflare:workers";\nexport class Tools extends WorkerEntrypoint {}\nexport default { fetch() { return new Response(null, { status: 503 }); } };\n',
);
await writeFile(
  resolve(root, ".local/wrangler/bootstrap.json"),
  JSON.stringify(
    {
      name: `${hosting.prefix}-tools`,
      account_id: accountId,
      main: "bootstrap.ts",
      compatibility_date: tools.compatibility_date,
      compatibility_flags: tools.compatibility_flags,
      workers_dev: false,
      preview_urls: false,
    },
    null,
    2,
  ) + "\n",
);
