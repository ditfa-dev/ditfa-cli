#!/usr/bin/env node
// Publishes the `ditfa` npm package and one package per platform from the
// GitHub Release archives.
//
//   node ditfa-cli/scripts/publish-npm.mjs --dist dist --version 0.2.0 [--dry-run]
//
// `ditfa` is a small launcher (bin/ditfa.js) whose optionalDependencies pull in
// only the package matching the user's OS and CPU, the way esbuild and turbo
// ship native binaries.

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PLATFORMS = [
  { target: "x86_64-unknown-linux-gnu", name: "ditfa-linux-x64", os: "linux", cpu: "x64" },
  { target: "aarch64-unknown-linux-gnu", name: "ditfa-linux-arm64", os: "linux", cpu: "arm64" },
  { target: "x86_64-apple-darwin", name: "ditfa-darwin-x64", os: "darwin", cpu: "x64" },
  { target: "aarch64-apple-darwin", name: "ditfa-darwin-arm64", os: "darwin", cpu: "arm64" },
  { target: "x86_64-pc-windows-msvc", name: "ditfa-win32-x64", os: "win32", cpu: "x64" },
  { target: "aarch64-pc-windows-msvc", name: "ditfa-win32-arm64", os: "win32", cpu: "arm64" },
];

function parseArgs(argv) {
  const args = { dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--dist") args.dist = argv[(i += 1)];
    else if (argv[i] === "--version") args.version = argv[(i += 1)];
    else if (argv[i] === "--dry-run") args.dryRun = true;
  }
  if (!args.dist || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(args.version ?? "")) {
    throw new Error("usage: publish-npm.mjs --dist <dir> --version <semver> [--dry-run]");
  }
  return args;
}

function run(command, args, cwd) {
  execFileSync(command, args, { cwd, stdio: "inherit" });
}

function publish(dir, dryRun) {
  const flags = ["publish", "--access", "public"];
  if (process.env.GITHUB_ACTIONS === "true") flags.push("--provenance");
  if (dryRun) flags.push("--dry-run");
  run("npm", flags, dir);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(root, "..");
const { dist, version, dryRun } = parseArgs(process.argv.slice(2));
const launcher = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const work = mkdtempSync(path.join(tmpdir(), "ditfa-npm-"));
const published = [];

for (const platform of PLATFORMS) {
  const windows = platform.os === "win32";
  const archive = path.resolve(dist, `ditfa-${platform.target}.${windows ? "zip" : "tar.gz"}`);
  if (!existsSync(archive)) {
    console.warn(`skipping ${platform.name}: ${path.basename(archive)} is not in the release`);
    continue;
  }
  const dir = path.join(work, platform.name);
  const bin = path.join(dir, "vendor", platform.target, "bin");
  mkdirSync(bin, { recursive: true });
  if (windows) run("unzip", ["-q", archive, "-d", bin]);
  else run("tar", ["-xzf", archive, "-C", bin]);
  cpSync(path.join(repoRoot, "LICENSE"), path.join(dir, "LICENSE"));
  writeFileSync(
    path.join(dir, "package.json"),
    `${JSON.stringify(
      {
        name: platform.name,
        version,
        description: `The ${platform.os}-${platform.cpu} binary for the Ditfa CLI.`,
        license: launcher.license,
        repository: launcher.repository,
        os: [platform.os],
        cpu: [platform.cpu],
        files: ["vendor", "LICENSE"],
      },
      null,
      2,
    )}\n`,
  );
  publish(dir, dryRun);
  published.push(platform.name);
}

if (published.length === 0) {
  throw new Error(`no release archives found in ${dist}`);
}

const main = path.join(work, "ditfa");
mkdirSync(main);
cpSync(path.join(root, "bin"), path.join(main, "bin"), { recursive: true });
cpSync(path.join(repoRoot, "LICENSE"), path.join(main, "LICENSE"));
cpSync(path.join(repoRoot, "README.md"), path.join(main, "README.md"));
const { devDependencies: _dev, packageManager: _pm, ...manifest } = launcher;
writeFileSync(
  path.join(main, "package.json"),
  `${JSON.stringify(
    {
      ...manifest,
      version,
      files: ["bin", "LICENSE", "README.md"],
      optionalDependencies: Object.fromEntries(published.map((name) => [name, version])),
    },
    null,
    2,
  )}\n`,
);
publish(main, dryRun);
console.log(`published ditfa@${version} with ${published.join(", ")}`);
