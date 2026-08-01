import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";
import * as vscode from "vscode";

import type { Logger } from "../util/logger";
import { readSettings } from "../util/settings";

export interface ResolvedBinary {
  path: string;
  /** Where the binary came from, surfaced in logs and error messages. */
  origin: "setting" | "bundled" | "path" | "workspace-build";
}

export class BinaryNotFoundError extends Error {
  constructor(readonly attempts: string[]) {
    super("Could not find the ditfa executable.");
    this.name = "BinaryNotFoundError";
  }
}

const EXE = process.platform === "win32" ? "ditfa.exe" : "ditfa";

/**
 * Locates the `ditfa` executable.
 *
 * Order is deliberate: an explicit setting always wins, then a binary shipped
 * inside a platform-specific VSIX, then whatever the user already installed on
 * PATH, and finally a Cargo build in the open workspace so contributors working
 * on ditfa itself get their local build without extra configuration.
 */
export function resolveBinary(context: vscode.ExtensionContext, logger: Logger): ResolvedBinary {
  const attempts: string[] = [];

  const configured = readSettings().executablePath;
  if (configured) {
    if (isExecutable(configured)) {
      logger.info(`using ditfa from setting: ${configured}`);
      return { path: configured, origin: "setting" };
    }
    attempts.push(`ditfa.executablePath = ${configured} (not executable)`);
  }

  const bundled = join(context.extensionPath, "dist", "bin", EXE);
  if (isExecutable(bundled)) {
    logger.info(`using bundled ditfa: ${bundled}`);
    return { path: bundled, origin: "bundled" };
  }
  attempts.push(`bundled binary at ${bundled}`);

  const onPath = findOnPath(EXE);
  if (onPath) {
    logger.info(`using ditfa from PATH: ${onPath}`);
    return { path: onPath, origin: "path" };
  }
  attempts.push(`${EXE} on PATH`);

  const built = findWorkspaceBuild();
  if (built) {
    logger.info(`using workspace Cargo build: ${built}`);
    return { path: built, origin: "workspace-build" };
  }
  attempts.push("Cargo build in the open workspace (target/release, target/debug)");

  throw new BinaryNotFoundError(attempts);
}

function isExecutable(candidate: string): boolean {
  try {
    accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function findOnPath(name: string): string | undefined {
  const raw = process.env.PATH;
  if (!raw) {
    return undefined;
  }
  for (const dir of raw.split(delimiter)) {
    if (!dir) {
      continue;
    }
    const candidate = join(dir, name);
    if (isExecutable(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

/** Cargo puts release and debug builds in sibling directories. */
function findWorkspaceBuild(): string | undefined {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const crateRoots = ["ditfa-rs"];
  const profiles = ["release", "debug"];

  for (const folder of folders) {
    const root = folder.uri.fsPath;
    for (const crate of crateRoots) {
      for (const profile of profiles) {
        const candidate = join(root, crate, "target", profile, EXE);
        if (isExecutable(candidate)) {
          return candidate;
        }
      }
    }
  }
  return undefined;
}

/** User-facing guidance for a failed lookup, shown in a modal. */
export function describeMissingBinary(error: BinaryNotFoundError): string {
  return [
    "Ditfa Code could not find the `ditfa` executable.",
    "",
    "Looked for:",
    ...error.attempts.map((attempt) => `  • ${attempt}`),
    "",
    "Install it with `npm i -g ditfa`, build it with",
    "`cargo build --release --manifest-path ditfa-rs/Cargo.toml --bin ditfa`,",
    "or set `ditfa.executablePath` to its location.",
  ].join("\n");
}
