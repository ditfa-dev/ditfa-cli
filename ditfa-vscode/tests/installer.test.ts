import { describe, expect, it } from "vitest";

import { archiveName, checksumFor, releaseTarget } from "../src/client/installer";
import { parseModelList } from "../src/providers/providerRegistry";

describe("releaseTarget", () => {
  it("maps every platform the release workflow builds", () => {
    expect(releaseTarget("darwin", "arm64")).toBe("aarch64-apple-darwin");
    expect(releaseTarget("linux", "x64")).toBe("x86_64-unknown-linux-gnu");
    expect(releaseTarget("win32", "x64")).toBe("x86_64-pc-windows-msvc");
  });

  it("refuses a platform with no build rather than guessing", () => {
    expect(releaseTarget("freebsd", "x64")).toBeNull();
  });
});

describe("archiveName", () => {
  it("matches the names the release publishes", () => {
    expect(archiveName("aarch64-apple-darwin")).toBe("ditfa-aarch64-apple-darwin.tar.gz");
    expect(archiveName("x86_64-pc-windows-msvc")).toBe("ditfa-x86_64-pc-windows-msvc.zip");
  });
});

describe("checksumFor", () => {
  const hash = "a".repeat(64);

  it("reads sha256sum output in both text and binary form", () => {
    expect(checksumFor(`${hash}  ditfa-x.tar.gz\n`, "ditfa-x.tar.gz")).toBe(hash);
    expect(checksumFor(`${hash} *ditfa-x.tar.gz\n`, "ditfa-x.tar.gz")).toBe(hash);
  });

  it("returns null for a file the list does not cover", () => {
    expect(checksumFor(`${hash}  other.zip\n`, "ditfa-x.tar.gz")).toBeNull();
  });
});

describe("parseModelList", () => {
  it("lists chat models and drops what cannot run an agent", () => {
    const models = parseModelList({
      data: [{ id: "gpt-x" }, { id: "text-embedding-3" }, { id: "whisper-1" }],
    });
    expect(models.map((model) => model.id)).toEqual(["gpt-x"]);
  });

  it("strips Gemini's models/ prefix and keeps a display name", () => {
    const [model] = parseModelList({ data: [{ id: "models/gemini-x", display_name: "Gemini X" }] });
    expect(model).toMatchObject({ id: "gemini-x", label: "Gemini X" });
  });

  it("treats an unexpected shape as an empty catalog", () => {
    expect(parseModelList({ error: "nope" })).toEqual([]);
  });
});
