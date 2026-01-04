/**
 * Copies the ts-rs generated app-server protocol types into src/protocol/generated.
 *
 * The Rust crate is the source of truth: running
 *   cargo test -p ditfa-app-server-protocol
 * regenerates ditfa-rs/app-server-protocol/schema/typescript. This script mirrors
 * that output so the extension type-checks against the exact wire contract.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const extensionRoot = resolve(here, "..");
const repoRoot = resolve(extensionRoot, "..");
const source = resolve(repoRoot, "ditfa-rs/app-server-protocol/schema/typescript");
const target = resolve(extensionRoot, "src/protocol/generated");

if (!existsSync(source)) {
  console.error(`[sync-protocol] schema not found at ${source}`);
  console.error("[sync-protocol] run: cargo test -p ditfa-app-server-protocol");
  process.exit(1);
}

rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
cpSync(source, target, { recursive: true });

const repaired = repairRebrandedFilenames(target);
if (repaired.length > 0) {
  console.warn(
    `[sync-protocol] renamed ${repaired.length} file(s) whose name and exported type disagree: ${repaired.join(", ")}`,
  );
  console.warn(
    "[sync-protocol] this is an upstream bug — the ditfa rebrand renamed generated filenames but not the ts-rs type names or import paths",
  );
}

/**
 * The ditfa fork renamed some generated files from `CodexX.ts` to `ditfaX.ts`
 * without renaming the type they export or the `import` paths that reference
 * them, so the schema does not type-check as shipped. Rename such files back to
 * match the type they actually export.
 */
function repairRebrandedFilenames(root) {
  const renamed = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      if (!entry.name.endsWith(".ts") || entry.name === "index.ts") {
        continue;
      }
      const declared = /export type (\w+)/.exec(readFileSync(path, "utf8"))?.[1];
      const stem = entry.name.slice(0, -3);
      if (declared && declared !== stem) {
        const next = join(dir, `${declared}.ts`);
        if (!existsSync(next)) {
          renameSync(path, next);
          renamed.push(`${stem} -> ${declared}`);
        }
      }
    }
  };
  walk(root);
  return renamed;
}

writeFileSync(
  resolve(target, "README.md"),
  [
    "# Generated protocol types",
    "",
    "Do not edit. Mirrored from `ditfa-rs/app-server-protocol/schema/typescript`",
    "by `pnpm run sync-protocol`.",
    "",
  ].join("\n"),
);

console.log(`[sync-protocol] copied protocol types to ${target}`);
