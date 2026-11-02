import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "..");
const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

function sources(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) {
      return name === "generated" ? [] : sources(path);
    }
    return name.endsWith(".ts") ? [readFileSync(path, "utf8")] : [];
  });
}

const source = sources(join(ROOT, "src")).join("\n");

describe("package.json", () => {
  const contributed: string[] = manifest.contributes.commands.map((item: { command: string }) => item.command);

  it("registers every command it contributes", () => {
    for (const command of contributed) {
      expect(source, command).toContain(`"${command}"`);
    }
  });

  it("only points menus and keybindings at commands that exist", () => {
    const menus = Object.values(manifest.contributes.menus).flat() as { command: string }[];
    for (const { command } of [...menus, ...manifest.contributes.keybindings]) {
      expect(contributed, command).toContain(command);
    }
  });

  it("leaves the editor's own shortcuts alone", () => {
    const keys = manifest.contributes.keybindings.flatMap((item: { key: string; mac: string }) => [item.key, item.mac]);
    expect(keys).not.toContain("cmd+shift+d");
    expect(keys).not.toContain("ctrl+shift+d");
    expect(keys).not.toContain("cmd+alt+d");
  });

  it("runs where the workspace is, so remote windows work", () => {
    expect(manifest.extensionKind).toEqual(["workspace"]);
  });

  it("every setting the code reads is declared", () => {
    const declared = Object.keys(manifest.contributes.configuration.properties);
    const read = [...source.matchAll(/config\.get<[^>]+>\("([\w.]+)"/g)].map((match) => `ditfa.${match[1]}`);
    expect(read.length).toBeGreaterThan(5);
    for (const key of read) {
      expect(declared, key).toContain(key);
    }
  });
});
