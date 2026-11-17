// Exercise the deployment CLI in a temporary checkout without Cloudflare access.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const hosting = {
  accountId: "0123456789abcdef0123456789abcdef",
  origin: "https://freight.example.com",
  databaseId: "11111111-1111-4111-8111-111111111111",
  databaseName: "client-staging-hosted",
  issuer: "https://client.cloudflareaccess.com",
  audience: "client-audience",
  administrators: ["admin@example.com"],
  reviewers: ["reviewer@example.com"],
  prefix: "client-staging",
};

await test("deployment CLI prepares portable configuration and synchronizes roles separately", async (): Promise<void> => {
  const directory = await mkdtemp(resolve(tmpdir(), "freight deployment-"));

  try {
    // Copy only public inputs; real local credentials and state stay outside the fixture.
    await mkdir(resolve(directory, "scripts"), { recursive: true });
    await mkdir(resolve(directory, "bin"));
    await cp(resolve(root, "scripts/deploy.sh"), resolve(directory, "scripts/deploy.sh"));
    await cp(resolve(root, "scripts/prepare-deployment.ts"), resolve(directory, "scripts/prepare-deployment.ts"));
    await symlink(resolve(root, "node_modules"), resolve(directory, "node_modules"), "dir");

    for (const path of ["apps/api/wrangler.jsonc", "apps/tools/wrangler.jsonc", "apps/web/deploy/wrangler.jsonc"]) {
      await mkdir(resolve(directory, path, ".."), { recursive: true });
      await cp(resolve(root, path), resolve(directory, path));
    }

    await writeFile(
      resolve(directory, "bin/terraform"),
      `#!/usr/bin/env node\nconsole.log(${JSON.stringify(JSON.stringify(hosting))});\n`,
      { mode: 0o700 },
    );
    await writeFile(
      resolve(directory, "bin/pnpm"),
      `#!/usr/bin/env node
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
const argumentsData = process.argv.slice(2);
appendFileSync('.local/invocations.jsonl', JSON.stringify(argumentsData) + '\\n');
if (argumentsData[0] === process.env.FAIL_COMMAND) process.exit(52);
if (argumentsData[0] === 'exec' && argumentsData[1] === 'esbuild') {
  const destination = argumentsData.find((argument) => argument.startsWith('--outfile=')).slice('--outfile='.length);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, 'export default {};');
}
if (argumentsData[0] === 'build' && process.env.SOURCE_CHANGE) {
  appendFileSync('scripts/deploy.sh', '\\n# Source changed during checks.\\n');
}
`,
      { mode: 0o700 },
    );
    await writeFile(
      resolve(directory, "bin/curl"),
      "#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({ success: true, result: [] }));\n",
      { mode: 0o700 },
    );
    const environment = {
      ...process.env,
      CLOUDFLARE_API_TOKEN: "fixture-token",
      FAIL_COMMAND: "",
      SOURCE_CHANGE: "",
      PATH: `${resolve(directory, "bin")}:${process.env.PATH}`,
    };
    const execution = promisify(execFile);
    const template = await readFile(resolve(directory, "apps/api/wrangler.jsonc"), "utf8");

    // Preparation must resolve shared resources, private services, and the public domain.
    await execution("bash", ["scripts/deploy.sh", "--prepare"], { cwd: directory, env: environment });
    const api = JSON.parse(await readFile(resolve(directory, ".local/wrangler/api.json"), "utf8"));
    const tools = JSON.parse(await readFile(resolve(directory, ".local/wrangler/tools.json"), "utf8"));
    const app = JSON.parse(await readFile(resolve(directory, ".local/wrangler/app.json"), "utf8"));
    assert.equal(api.name, "client-staging-api");
    assert.equal(api.account_id, hosting.accountId);
    assert.equal(api.d1_databases[0].database_id, hosting.databaseId);
    assert.equal(tools.d1_databases[0].database_id, hosting.databaseId);
    assert.equal(api.vars.ACCESS_AUDIENCE, hosting.audience);
    assert.equal(api.vars.ACCESS_ISSUER, hosting.issuer);
    assert.equal(api.services[0].service, "client-staging-tools");
    assert.equal(tools.services[0].service, "client-staging-api");
    assert.equal(tools.queues.consumers[0].dead_letter_queue, "client-staging-analysis-dead-letter");
    assert.equal(app.vars.PUBLIC_ORIGIN, hosting.origin);
    assert.equal(app.routes[0].pattern, "freight.example.com");
    assert.equal(app.workers_dev, false);
    assert.equal(api.env, undefined);
    assert.equal(api.vars.OPENAI_API_KEY, undefined);
    assert.equal(await readFile(resolve(directory, "apps/api/wrangler.jsonc"), "utf8"), template);
    await assert.rejects(readFile(resolve(directory, ".local/invocations.jsonl")));

    // Administration uses D1 explicitly and removes stale Access identities only.
    await execution("bash", ["scripts/deploy.sh", "--roles"], { cwd: directory, env: environment });
    const argumentsData = JSON.parse((await readFile(resolve(directory, ".local/invocations.jsonl"), "utf8")).trim());
    assert.deepEqual(argumentsData.slice(0, 5), ["exec", "wrangler", "d1", "execute", "DB"]);
    assert.ok(argumentsData.includes("--remote"));
    const statements = await readFile(resolve(directory, ".local/hosted-roles.sql"), "utf8");
    assert.match(statements, /DELETE FROM users WHERE id LIKE 'access:%' AND id NOT IN/);
    assert.match(statements, /access:admin@example.com/);
    assert.match(statements, /"role":"administrator"/);
    assert.match(statements, /"role":"reviewer"/);
    assert.match(statements, /UPDATE revision/);

    // Run the complete shell pipeline against fake tools, retaining real file freezing.
    for (const path of ["apps/api/dist", "apps/tools/dist", "apps/web/dist/client", "packages/backend/migrations"]) {
      await mkdir(resolve(directory, path), { recursive: true });
      await writeFile(resolve(directory, path, "fixture.txt"), "validated artifact");
    }
    await writeFile(resolve(directory, ".gitignore"), "node_modules\n.local\ndist\n");
    await writeFile(resolve(directory, "obsolete.txt"), "Tracked deletion must be included in the digest.");
    await execution("git", ["init", "--quiet"], { cwd: directory });
    await execution("git", ["add", "."], { cwd: directory });
    await execution(
      "git",
      [
        "-c",
        "user.name=Deployment test",
        "-c",
        "user.email=test@example.com",
        "commit",
        "--quiet",
        "-m",
        "test: deployment fixture",
      ],
      { cwd: directory },
    );
    await rm(resolve(directory, "obsolete.txt"));
    await rm(resolve(directory, ".local/invocations.jsonl"));
    await execution("bash", ["scripts/deploy.sh"], { cwd: directory, env: environment });
    const commands = (await readFile(resolve(directory, ".local/invocations.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line): string[] => JSON.parse(line));
    const deployments = commands.filter(
      (argumentsData): boolean =>
        argumentsData[0] === "exec" && argumentsData[1] === "wrangler" && argumentsData[2] === "deploy",
    );
    assert.equal(deployments.length, 4);
    assert.equal(deployments[0].at(-1), ".local/wrangler/bootstrap.json");
    assert.ok(deployments[1].at(-1)?.endsWith("/api.json"));
    assert.ok(deployments[2].at(-1)?.endsWith("/tools.json"));
    assert.ok(deployments[3].at(-1)?.endsWith("/app.json"));
    const metadata = JSON.parse(await readFile(resolve(directory, ".local/deployment.json"), "utf8"));
    const releaseApi = JSON.parse(await readFile(resolve(metadata.release, "api.json"), "utf8"));
    assert.equal(releaseApi.main, "api/worker.js");
    assert.equal(releaseApi.d1_databases[0].migrations_dir, "migrations");
    assert.equal(await readFile(resolve(metadata.release, "api/fixture.txt"), "utf8"), "validated artifact");
    assert.match(await readFile(resolve(metadata.release, "deployed-at"), "utf8"), /^\d{4}-\d{2}-\d{2}T/);

    // Failed validation must stop before migrations or any Worker publication.
    await rm(resolve(directory, ".local/invocations.jsonl"));
    await assert.rejects(
      execution("bash", ["scripts/deploy.sh"], { cwd: directory, env: { ...environment, FAIL_COMMAND: "test" } }),
    );
    const failureCommands = await readFile(resolve(directory, ".local/invocations.jsonl"), "utf8");
    assert.doesNotMatch(failureCommands, /"wrangler"/);
    assert.equal(
      await readFile(resolve(directory, ".local/deployment.json"), "utf8"),
      JSON.stringify(metadata, null, 2) + "\n",
    );

    // Editing source during validation must also prevent publication.
    await rm(resolve(directory, ".local/invocations.jsonl"));
    await assert.rejects(
      execution("bash", ["scripts/deploy.sh"], { cwd: directory, env: { ...environment, SOURCE_CHANGE: "1" } }),
    );
    assert.doesNotMatch(await readFile(resolve(directory, ".local/invocations.jsonl"), "utf8"), /"wrangler"/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
