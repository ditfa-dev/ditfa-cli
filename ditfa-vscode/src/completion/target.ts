import type { ProviderInfo } from "../providers/providerRegistry";
import type { CompletionTarget } from "./client";

export interface CompletionPreferences {
  /** Empty follows the chat provider. */
  provider: string;
  /** Empty follows the chat model, or a coder model a local server has loaded. */
  model: string;
}

export interface TargetDeps {
  preferences: CompletionPreferences;
  chatProvider: string | null;
  chatModel: string;
  providers: ProviderInfo[];
  /** A key stored for `name`, from the keychain. */
  storedKey(name: string): Promise<string | undefined>;
  env: Record<string, string | undefined>;
  /** Model ids a local server offers; empty when it is not running. */
  localModels(baseUrl: string): Promise<string[]>;
}

export type TargetFailure = "noProvider" | "unknownProvider" | "noKey" | "noModel" | "notRunning";

export type TargetResult =
  | { ok: true; target: CompletionTarget }
  | { ok: false; reason: TargetFailure; provider: ProviderInfo | null; message: string };

/** The environment variable name a provider's key is kept under. */
export function keyName(provider: ProviderInfo): string {
  return provider.envKey ?? `${provider.id.replace(/[^a-z0-9]/gi, "_").toUpperCase()}_API_KEY`;
}

const CODE_MODEL = /coder|codestral|starcoder|codellama|codegemma|granite-code/i;
const NOT_FOR_TEXT = /embed|whisper|tts|rerank|moderation|image/i;

/** Picks the model a local server should answer Tab with: a code model if one is loaded. */
export function pickLocalModel(models: string[]): string | null {
  const usable = models.filter((id) => !NOT_FOR_TEXT.test(id));
  return usable.find((id) => CODE_MODEL.test(id)) ?? usable[0] ?? null;
}

export async function resolveTarget(deps: TargetDeps): Promise<TargetResult> {
  const id = deps.preferences.provider || deps.chatProvider;
  if (!id) {
    return { ok: false, reason: "noProvider", provider: null, message: "Choose a provider for Tab autocomplete." };
  }
  const provider = deps.providers.find((candidate) => candidate.id === id) ?? null;
  if (!provider?.baseUrl) {
    return {
      ok: false,
      reason: "unknownProvider",
      provider,
      message: `Tab autocomplete does not know where to reach "${id}".`,
    };
  }

  const local = provider.kind === "local";
  let apiKey: string | undefined;
  if (!local) {
    const name = keyName(provider);
    apiKey = (await deps.storedKey(name)) || deps.env[name] || undefined;
    if (!apiKey) {
      return { ok: false, reason: "noKey", provider, message: `Tab autocomplete needs a ${provider.name} API key.` };
    }
  }

  let model = deps.preferences.model;
  if (!model && local) {
    const available = await deps.localModels(provider.baseUrl);
    if (available.length === 0) {
      return {
        ok: false,
        reason: "notRunning",
        provider,
        message: `${provider.name} is not running, or has no model loaded.`,
      };
    }
    model = pickLocalModel(available) ?? "";
  }
  model ||= deps.chatModel;
  if (!model) {
    return { ok: false, reason: "noModel", provider, message: "Choose a fast model for Tab autocomplete." };
  }

  return {
    ok: true,
    target: {
      providerId: provider.id,
      providerName: provider.name,
      baseUrl: provider.baseUrl,
      ...(apiKey ? { apiKey } : {}),
      model,
      local,
    },
  };
}
