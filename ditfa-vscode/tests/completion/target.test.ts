import { describe, expect, it } from "vitest";

import type { ProviderInfo } from "../../src/providers/providerRegistry";
import { keyName, pickLocalModel, resolveTarget, type TargetDeps } from "../../src/completion/target";

const provider = (partial: Partial<ProviderInfo> & { id: string }): ProviderInfo => ({
  name: partial.id,
  baseUrl: `https://${partial.id}.example/v1`,
  envKey: null,
  builtIn: true,
  kind: "apiKey",
  ...partial,
});

const deps = (overrides: Partial<TargetDeps> = {}): TargetDeps => ({
  preferences: { provider: "", model: "" },
  chatProvider: "deepseek",
  chatModel: "chat-model",
  providers: [
    provider({ id: "deepseek", envKey: "DEEPSEEK_API_KEY" }),
    provider({ id: "openai" }),
    provider({ id: "ollama", kind: "local", baseUrl: "http://localhost:11434/v1" }),
  ],
  storedKey: async () => undefined,
  env: {},
  localModels: async () => [],
  ...overrides,
});

describe("resolveTarget", () => {
  it("follows the chat provider and model when nothing else is chosen", async () => {
    const result = await resolveTarget(deps({ storedKey: async () => "k" }));
    expect(result).toMatchObject({ ok: true, target: { providerId: "deepseek", model: "chat-model", apiKey: "k", local: false } });
  });

  it("prefers the provider and model picked for Tab", async () => {
    const result = await resolveTarget(
      deps({ preferences: { provider: "openai", model: "fast" }, storedKey: async () => "k" }),
    );
    expect(result).toMatchObject({ ok: true, target: { providerId: "openai", model: "fast" } });
  });

  it("reads a key from the environment when none is stored", async () => {
    const result = await resolveTarget(deps({ env: { DEEPSEEK_API_KEY: "from-env" } }));
    expect(result).toMatchObject({ ok: true, target: { apiKey: "from-env" } });
  });

  it("keeps a key for a provider with no variable of its own under a predictable name", () => {
    expect(keyName(provider({ id: "openai" }))).toBe("OPENAI_API_KEY");
    expect(keyName(provider({ id: "my-proxy" }))).toBe("MY_PROXY_API_KEY");
  });

  it("asks for a key rather than sending an anonymous request", async () => {
    expect(await resolveTarget(deps())).toMatchObject({ ok: false, reason: "noKey" });
  });

  it("needs no key for a local server, and picks the code model on it", async () => {
    const result = await resolveTarget(
      deps({
        chatProvider: "ollama",
        localModels: async () => ["llama3.1:8b", "qwen2.5-coder:1.5b", "nomic-embed-text"],
      }),
    );
    expect(result).toMatchObject({ ok: true, target: { providerId: "ollama", model: "qwen2.5-coder:1.5b", local: true } });
    expect(result.ok && result.target.apiKey).toBeFalsy();
  });

  it("says so when the local server is not running", async () => {
    expect(await resolveTarget(deps({ chatProvider: "ollama" }))).toMatchObject({ ok: false, reason: "notRunning" });
  });

  it("asks for a model when there is none to fall back on", async () => {
    const result = await resolveTarget(deps({ chatModel: "", storedKey: async () => "k" }));
    expect(result).toMatchObject({ ok: false, reason: "noModel" });
  });

  it("needs a provider", async () => {
    expect(await resolveTarget(deps({ chatProvider: null }))).toMatchObject({ ok: false, reason: "noProvider" });
    expect(await resolveTarget(deps({ chatProvider: "nowhere" }))).toMatchObject({ ok: false, reason: "unknownProvider" });
  });
});

describe("pickLocalModel", () => {
  it("prefers a code model and skips embedding models", () => {
    expect(pickLocalModel(["nomic-embed-text", "llama3.1", "codestral"])).toBe("codestral");
    expect(pickLocalModel(["nomic-embed-text", "llama3.1"])).toBe("llama3.1");
    expect(pickLocalModel(["nomic-embed-text"])).toBeNull();
  });
});
