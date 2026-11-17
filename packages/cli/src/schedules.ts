import { writeFile } from "node:fs/promises";
import { z } from "zod";
import { requestCloudflare } from "./cloudflare.ts";
import { CommandError } from "./errors.ts";

const scheduleSchema = z.object({
  accountId: z.string().regex(/^[a-f0-9]{32}$/),
  scriptName: z.string().regex(/^[a-zA-Z0-9_-]+$/),
  schedules: z.array(z.string().min(1)),
});

export async function reconcileSchedules(): Promise<void> {
  const lifecycle = z.enum(["plan", "create", "read", "update", "delete"]).parse(process.env.TF_SCRIPT_LIFECYCLE);
  const configuration = scheduleSchema.parse(JSON.parse(process.env.TF_SCRIPT_INPUTS ?? ""));
  const schedules = [...configuration.schedules].sort();
  const path = `/accounts/${configuration.accountId}/workers/scripts/${encodeURIComponent(configuration.scriptName)}/schedules`;
  const output = process.env.TF_SCRIPT_OUTPUT;

  if (lifecycle === "delete") {
    await requestCloudflare(path, { method: "PUT", body: [], absence: { status: 404, code: 10007 } });
    return;
  }

  if (!output) {
    throw new CommandError(
      "schedule_output_missing",
      "Terraform schedule output is missing.",
      "Run the command through Terraform.",
    );
  }

  let actual = schedules;
  let missing = false;

  if (lifecycle === "create" || lifecycle === "update") {
    await requestCloudflare(path, { method: "PUT", body: schedules.map((cron): { cron: string } => ({ cron })) });
  } else if (lifecycle === "read") {
    const result = await requestCloudflare(path, { absence: { status: 404, code: 10007 } });

    if (result === null) {
      missing = true;
      actual = [];
    } else {
      const response = z.object({ schedules: z.array(z.object({ cron: z.string() })) }).parse(result);
      actual = response.schedules.map((schedule): string => schedule.cron).sort();
    }
  }

  const drift = lifecycle === "read" && (missing || JSON.stringify(actual) !== JSON.stringify(schedules));
  await writeFile(
    output,
    JSON.stringify({ schedules: actual, ...(drift ? { __meta: { output_drift_detected: true } } : {}) }),
  );
}
