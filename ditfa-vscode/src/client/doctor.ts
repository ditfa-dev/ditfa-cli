import { execFile } from "node:child_process";
import { arch, platform, release } from "node:os";
import { promisify } from "node:util";
import * as vscode from "vscode";

import { BUILT_IN_PROVIDERS, probeLocal } from "../providers/providerRegistry";
import type { ResolvedBinary } from "./binary";
import { releaseTarget } from "./installer";

const run = promisify(execFile);

export interface DoctorInput {
  extensionVersion: string;
  binary: ResolvedBinary | null;
  binaryAttempts: string[];
  connection: string;
  connectionError: string | null;
  engineVersion: string | null;
  provider: string | null;
  model: string | null;
  storedKeys: string[];
}

/**
 * Everything support would ask for, as one Markdown report the user can read and
 * paste. Holds paths and versions, never a key's value.
 */
export async function buildDoctorReport(input: DoctorInput): Promise<string> {
  const lines: string[] = [
    "# Ditfa Code diagnostics",
    "",
    `- Extension: ${input.extensionVersion}`,
    `- Editor: ${vscode.env.appName} ${vscode.version}`,
    `- Remote: ${vscode.env.remoteName ?? "none"}`,
    `- System: ${platform()} ${release()} ${arch()}`,
    `- Published engine for this system: ${releaseTarget(process.platform, process.arch) ?? "none"}`,
    "",
    "## Engine",
    "",
    `- State: ${input.connection}`,
  ];

  if (input.connectionError) {
    lines.push(`- Error: ${input.connectionError}`);
  }
  if (input.binary) {
    lines.push(`- Binary: ${input.binary.path} (${input.binary.origin})`);
    lines.push(`- Version check: ${await versionOf(input.binary.path)}`);
  } else {
    lines.push("- Binary: not found", ...input.binaryAttempts.map((attempt) => `  - tried ${attempt}`));
  }
  if (input.engineVersion) {
    lines.push(`- Running version: ${input.engineVersion}`);
  }

  lines.push(
    "",
    "## Models",
    "",
    `- Provider: ${input.provider ?? "default"}`,
    `- Model: ${input.model ?? "default"}`,
    `- Stored keys: ${input.storedKeys.length > 0 ? input.storedKeys.join(", ") : "none"}`,
  );
  for (const provider of BUILT_IN_PROVIDERS) {
    if (provider.kind === "local" && provider.baseUrl) {
      const up = await probeLocal(provider.baseUrl);
      lines.push(`- ${provider.name}: ${up ? "running" : "not running"} at ${provider.baseUrl}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

async function versionOf(path: string): Promise<string> {
  try {
    const { stdout } = await run(path, ["--version"], { timeout: 10_000, windowsHide: true });
    return stdout.trim() || "no output";
  } catch (error) {
    return `failed: ${error instanceof Error ? error.message : String(error)}`;
  }
}
