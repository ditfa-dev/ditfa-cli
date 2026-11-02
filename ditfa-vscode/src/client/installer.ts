import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { chmod, mkdir, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import type { InstallProgress } from "../session/types";
import type { Logger } from "../util/logger";

/**
 * Installs the ditfa engine for users who have never heard of a CLI.
 *
 * The VSIX stays small and platform-neutral; the first run fetches the one
 * binary this machine needs from the same GitHub release the install scripts
 * use, and refuses it unless it matches the published SHA-256. It runs wherever
 * the extension host runs, so a Remote-SSH or WSL window installs on that side.
 */

const REPOSITORY = "ditfa-dev/ditfa-cli";
const BASE_URL = `https://github.com/${REPOSITORY}/releases/latest/download`;
const CONNECT_TIMEOUT_MS = 30_000;

const run = promisify(execFile);

/** Release asset target for this machine, or null where no build is published. */
export function releaseTarget(platform: string, arch: string): string | null {
  const key = `${platform}-${arch}`;
  const targets: Record<string, string> = {
    "darwin-arm64": "aarch64-apple-darwin",
    "darwin-x64": "x86_64-apple-darwin",
    "linux-x64": "x86_64-unknown-linux-gnu",
    "linux-arm64": "aarch64-unknown-linux-gnu",
    "win32-x64": "x86_64-pc-windows-msvc",
    "win32-arm64": "aarch64-pc-windows-msvc",
  };
  return targets[key] ?? null;
}

export function archiveName(target: string): string {
  return `ditfa-${target}.${target.includes("windows") ? "zip" : "tar.gz"}`;
}

/** Finds a file's hash in `sha256sum`-style output. */
export function checksumFor(sums: string, file: string): string | null {
  for (const line of sums.split("\n")) {
    const match = /^([0-9a-f]{64})\s+\*?(\S+)\s*$/i.exec(line.trim());
    if (match?.[1] && match[2] === file) {
      return match[1].toLowerCase();
    }
  }
  return null;
}

export type ProgressListener = (progress: InstallProgress) => void;

/** Downloads, verifies, and unpacks the engine into `directory`, replacing what is there. */
export async function installEngine(
  directory: string,
  onProgress: ProgressListener,
  logger: Logger,
): Promise<void> {
  const target = releaseTarget(process.platform, process.arch);
  if (!target) {
    throw new Error(`No Ditfa engine is published for ${process.platform}-${process.arch}.`);
  }
  const archive = archiveName(target);
  const staging = `${directory}.staging-${randomBytes(4).toString("hex")}`;
  await mkdir(staging, { recursive: true });

  try {
    onProgress({ stage: "download", percent: 0 });
    const sums = await fetchText(`${BASE_URL}/SHA256SUMS`);
    const expected = checksumFor(sums, archive);
    if (!expected) {
      throw new Error(`The release does not list a checksum for ${archive}.`);
    }

    const archivePath = join(staging, archive);
    const actual = await download(`${BASE_URL}/${archive}`, archivePath, (percent) =>
      onProgress({ stage: "download", percent }),
    );

    onProgress({ stage: "verify", percent: null });
    if (actual !== expected) {
      throw new Error("The download failed its checksum and was discarded.");
    }

    onProgress({ stage: "unpack", percent: null });
    const unpacked = join(staging, "unpacked");
    await mkdir(unpacked);
    // Windows 10+ ships bsdtar, which also reads zip archives.
    await run("tar", [archive.endsWith(".zip") ? "-xf" : "-xzf", archivePath, "-C", unpacked]);
    if (process.platform !== "win32") {
      for (const name of await readdir(unpacked)) {
        if (name.startsWith("ditfa")) {
          await chmod(join(unpacked, name), 0o755);
        }
      }
    }

    await rm(directory, { recursive: true, force: true });
    await rename(unpacked, directory);
    logger.info(`installed the ditfa engine into ${directory}`);
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, { signal: AbortSignal.timeout(CONNECT_TIMEOUT_MS) });
  if (!response.ok) {
    throw new Error(`Could not reach the Ditfa release server (HTTP ${response.status}).`);
  }
  return response.text();
}

/** Streams `url` to `path` and resolves with its SHA-256. */
async function download(
  url: string,
  path: string,
  onPercent: (percent: number | null) => void,
): Promise<string> {
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`Could not download the Ditfa engine (HTTP ${response.status}).`);
  }

  const size = Number(response.headers.get("content-length") ?? 0);
  const hash = createHash("sha256");
  const file = createWriteStream(path);
  let received = 0;
  let reported = -1;

  try {
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      hash.update(value);
      received += value.length;
      if (!file.write(value)) {
        await new Promise<void>((resolve) => file.once("drain", () => resolve()));
      }
      const percent = size > 0 ? Math.floor((received / size) * 100) : null;
      if (percent !== reported) {
        reported = percent ?? -1;
        onPercent(percent);
      }
    }
  } finally {
    await new Promise<void>((resolve) => file.end(() => resolve()));
  }
  return hash.digest("hex");
}
