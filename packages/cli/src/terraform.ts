import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { z } from "zod";
import { loadEnvironment, requestCloudflare } from "./cloudflare.ts";
import { repositoryPath } from "./database.ts";
import { CommandError } from "./errors.ts";

export async function terraformEnvironment(): Promise<NodeJS.ProcessEnv> {
  const environment = loadEnvironment();
  const account = z
    .string()
    .regex(/^[a-f0-9]{32}$/)
    .parse(environment.CLOUDFLARE_ACCOUNT_ID);
  const token = z.string().min(1).parse(environment.CLOUDFLARE_API_TOKEN);
  let verified: unknown;

  try {
    verified = await requestCloudflare(`/accounts/${account}/tokens/verify`);
  } catch (accountError) {
    // Account and user tokens have distinct verification endpoints.
    try {
      verified = await requestCloudflare("/user/tokens/verify");
    } catch {
      throw accountError;
    }
  }

  const verification = z.object({ id: z.string().min(1) }).parse(verified);

  return {
    ...environment,
    TF_VAR_account_id: account,
    AWS_ACCESS_KEY_ID: verification.id,
    AWS_SECRET_ACCESS_KEY: createHash("sha256").update(token).digest("hex"),
  };
}

export function terraformArguments(arguments_: string[], environment: NodeJS.ProcessEnv): string[] {
  const args = arguments_.filter((argument): boolean => argument !== "--");
  const working = args.find((argument): boolean => argument.startsWith("-chdir="))?.slice(7) ?? "infrastructure";
  const directory = resolve(repositoryPath, working);
  const command = args.find((argument): boolean => !argument.startsWith("-"));

  if (command !== "init" || environment.TF_LOCAL_BACKEND === "1" || args.includes("-backend=false")) {
    return args;
  }
  const account = environment.TF_VAR_account_id;
  const key = directory.endsWith("/bootstrap") ? "bootstrap/terraform.tfstate" : "prod/terraform.tfstate";

  return [
    ...args,
    "-backend-config=bucket=voice-freight-terraform-state",
    `-backend-config=key=${key}`,
    `-backend-config=endpoints={s3="https://${account}.r2.cloudflarestorage.com"}`,
  ];
}

export async function runTerraform(arguments_: string[], capture = false): Promise<string> {
  const environment = await terraformEnvironment();
  const args = terraformArguments(arguments_, environment);

  return await new Promise((resolvePromise, reject): void => {
    const child = spawn("terraform", args, {
      cwd: repositoryPath,
      env: environment,
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    });
    let output = "";
    let errors = "";
    child.stdout?.on("data", (chunk: Buffer): void => {
      output += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer): void => {
      errors += chunk.toString();
    });
    child.on("error", (): void =>
      reject(new CommandError("terraform_unavailable", "Cannot start Terraform.", "Install Terraform 1.12 or newer.")),
    );
    child.on("close", (code): void => {
      if (code !== 0) {
        reject(
          new CommandError(
            "terraform_failed",
            capture ? errors.trim() || "Terraform failed." : `Terraform exited with status ${code ?? "unknown"}.`,
            "Review the Terraform output and retry.",
          ),
        );
      } else {
        resolvePromise(output);
      }
    });
  });
}
