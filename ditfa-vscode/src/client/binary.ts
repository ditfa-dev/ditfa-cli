import { statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import * as vscode from "vscode";

import type { Logger } from "../util/logger";
import { readSettings } from "../util/settings";

export interface ResolvedBinary {
  path: string;
  /** Where the binary came from, surfaced in logs and diagnostics. */
  origin: "setting" | "bundled" | "path" | "known-location" | "managed" | "workspace-build";
}

export class BinaryNotFoundError extends Error {
  constructor(readonly attempts: string[]) {
    super("Could not find the ditfa executable.");
    this.name = "BinaryNotFoundError";
  }
}

const WINDOWS = process.platform === "win32";
const EXE = WINDOWS ? "ditfa.exe" : "ditfa";
/** npm puts a batch shim on PATH on Windows, not an .exe. */
const PATH_NAMES = WINDOWS ? ["ditfa.exe", "ditfa.cmd"] : ["ditfa"];

/** Where the extension keeps the engine it installed itself. */
export function managedBinaryDirectory(context: vscode.ExtensionContext): string {
  return join(context.globalStorageUri.fsPath, "bin");
}

export function managedBinaryPath(context: vscode.ExtensionContext): string {
  return join(managedBinaryDirectory(context), EXE);
}

/**
 * Locates the `ditfa` executable.
 *
 * Order is deliberate: an explicit setting always wins, then a binary shipped
 * inside a platform-specific VSIX, then whatever the user already installed,
 * then the copy this extension installed, and finally a Cargo build in the open
 * workspace so contributors working on ditfa itself get their local build
 * without extra configuration.
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

  const onPath = findIn((process.env.PATH ?? "").split(delimiter));
  if (onPath) {
    logger.info(`using ditfa from PATH: ${onPath}`);
    return { path: onPath, origin: "path" };
  }
  attempts.push(`${EXE} on PATH`);

  // An app started from the Dock or a launcher may not have the shell's PATH.
  const known = findIn(knownDirectories());
  if (known) {
    logger.info(`using ditfa from ${known}`);
    return { path: known, origin: "known-location" };
  }
  attempts.push("the usual install locations");

  const managed = managedBinaryPath(context);
  if (isExecutable(managed)) {
    logger.info(`using managed ditfa: ${managed}`);
    return { path: managed, origin: "managed" };
  }
  attempts.push(`managed install at ${managed}`);

  const built = findWorkspaceBuild();
  if (built) {
    logger.info(`using workspace Cargo build: ${built}`);
    return { path: built, origin: "workspace-build" };
  }
  attempts.push("Cargo build in the open workspace (target/release, target/debug)");

  throw new BinaryNotFoundError(attempts);
}

function knownDirectories(): string[] {
  const home = homedir();
  const directories = [join(home, ".local", "bin"), join(home, ".cargo", "bin")];
  if (WINDOWS) {
    const appData = process.env.APPDATA;
    const localAppData = process.env.LOCALAPPDATA;
    if (appData) {
      directories.push(join(appData, "npm"));
    }
    if (localAppData) {
      directories.push(join(localAppData, "ditfa", "bin"));
    }
  } else {
    directories.push("/opt/homebrew/bin", "/usr/local/bin");
  }
  return directories;
}

function isExecutable(candidate: string): boolean {
  try {
    // A directory also passes an X_OK check, so look at what it actually is.
    const stat = statSync(candidate);
    return stat.isFile() && (WINDOWS || (stat.mode & 0o111) !== 0);
  } catch {
    return false;
  }
}

function findIn(directories: string[]): string | undefined {
  for (const directory of directories) {
    if (!directory) {
      continue;
    }
    for (const name of PATH_NAMES) {
      const candidate = join(directory, name);
      if (isExecutable(candidate)) {
        return candidate;
      }
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
