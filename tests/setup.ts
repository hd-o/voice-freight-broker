import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";

export default async function prepareTestWorkers(): Promise<() => Promise<void>> {
  const root = resolve(import.meta.dirname, "..");

  await promisify(execFile)(
    "pnpm",
    ["exec", "vp", "run", "--filter", "@voice-freight/api", "--filter", "@voice-freight/tools", "build:test"],
    { cwd: root, timeout: 60_000 },
  );

  // Both /tmp and the workspace are host-mounted in the devcontainer. Chromium's
  // mmap-backed scratch files need the container's native filesystem on Linux.
  const directory = process.platform === "linux" ? "/var/tmp" : tmpdir();
  const temporaryDirectory = await mkdtemp(resolve(directory, "voice-freight-playwright-"));
  const previousDirectory = process.env.TMPDIR;
  process.env.TMPDIR = temporaryDirectory;

  return async (): Promise<void> => {
    if (previousDirectory === undefined) {
      delete process.env.TMPDIR;
    } else {
      process.env.TMPDIR = previousDirectory;
    }

    await rm(temporaryDirectory, { recursive: true, force: true });
  };
}
