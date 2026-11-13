import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

export default async function prepareTestWorkers() {
  const root = resolve(import.meta.dirname, "..");

  await promisify(execFile)(
    "pnpm",
    [
      "exec",
      "vp",
      "run",
      "--filter",
      "@voice-freight/api",
      "--filter",
      "@voice-freight/tools",
      "build:test",
    ],
    { cwd: root, timeout: 60_000 },
  );

  // Keep Chromium's mmap-backed scratch files off the host-mounted /tmp.
  const directory = resolve(root, ".local");
  await mkdir(directory, { recursive: true });
  const temporaryDirectory = await mkdtemp(resolve(directory, "playwright-"));
  const previousDirectory = process.env.TMPDIR;
  process.env.TMPDIR = temporaryDirectory;

  return async () => {
    if (previousDirectory === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousDirectory;

    await rm(temporaryDirectory, { recursive: true, force: true });
  };
}
