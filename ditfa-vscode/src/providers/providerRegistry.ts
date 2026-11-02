import type { AppServerClient } from "../client/appServerClient";
import type { Model } from "../protocol";
import type { ModelListResponse } from "../protocol/generated/v2/ModelListResponse";
import type { ModelChoice } from "../session/types";
import type { Logger } from "../util/logger";

export interface ProviderInfo {
  id: string;
  name: string;
  baseUrl: string | null;
  /** Env var the provider reads its key from, when it uses one. */
  envKey: string | null;
  /** True when ditfa ships an adapter for this provider out of the box. */
  builtIn: boolean;
  kind: "account" | "apiKey" | "local";
  /** Where to get a key, shown when asking for one. */
  keyUrl?: string;
}

/**
 * Providers ditfa supports without any `config.toml` entry. Users can override
 * or extend these with `[model_providers.*]`.
 */
export const BUILT_IN_PROVIDERS: ProviderInfo[] = [
  {
    id: "ditfa",
    name: "Ditfa",
    baseUrl: "https://api.ditfa.com/api/v1",
    envKey: "DITFA_API_KEY",
    builtIn: true,
    kind: "account",
    keyUrl: "https://chat.ditfa.com/api-keys",
  },
  {
    id: "openai",
    name: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    envKey: null,
    builtIn: true,
    kind: "apiKey",
    keyUrl: "https://platform.openai.com/api-keys",
  },
  {
    id: "anthropic",
    name: "Anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    envKey: "ANTHROPIC_API_KEY",
    builtIn: true,
    kind: "apiKey",
    keyUrl: "https://console.anthropic.com/settings/keys",
  },
  {
    id: "gemini",
    name: "Google Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    envKey: "GEMINI_API_KEY",
    builtIn: true,
    kind: "apiKey",
    keyUrl: "https://aistudio.google.com/apikey",
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    envKey: "OPENROUTER_API_KEY",
    builtIn: true,
    kind: "apiKey",
    keyUrl: "https://openrouter.ai/keys",
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    envKey: "DEEPSEEK_API_KEY",
    builtIn: true,
    kind: "apiKey",
    keyUrl: "https://platform.deepseek.com/api_keys",
  },
  {
    id: "ollama",
    name: "Ollama",
    baseUrl: "http://localhost:11434/v1",
    envKey: null,
    builtIn: true,
    kind: "local",
  },
  {
    id: "lmstudio",
    name: "LM Studio",
    baseUrl: "http://localhost:1234/v1",
    envKey: null,
    builtIn: true,
    kind: "local",
  },
];

/** Every variable the engine might read a stored key from. */
export const PROVIDER_ENV_KEYS = BUILT_IN_PROVIDERS.flatMap((provider) =>
  provider.envKey ? [provider.envKey] : [],
);

const FETCH_TIMEOUT_MS = 6_000;
/** Everything an OpenAI-style `/models` lists that cannot run a coding agent. */
const NOT_CHAT_MODELS = /embed|whisper|tts|dall-e|moderation|audio|transcribe|image|aqa|rerank/i;

/** Reads an OpenAI-style `/models` response, which all the hosted providers speak. */
export function parseModelList(body: unknown): ModelChoice[] {
  const data = (body as { data?: unknown }).data;
  if (!Array.isArray(data)) {
    return [];
  }
  const models: ModelChoice[] = [];
  for (const raw of data as Record<string, unknown>[]) {
    if (typeof raw.id !== "string") {
      continue;
    }
    // Gemini prefixes ids with `models/`, which its own API then rejects.
    const id = raw.id.replace(/^models\//, "");
    if (NOT_CHAT_MODELS.test(id)) {
      continue;
    }
    const label =
      typeof raw.display_name === "string"
        ? raw.display_name
        : typeof raw.name === "string"
          ? raw.name
          : id;
    models.push({ id, label, description: null, efforts: [], isDefault: false });
  }
  return models.sort((a, b) => b.id.localeCompare(a.id));
}

/** True when a local model server answers on `baseUrl`. */
export async function probeLocal(baseUrl: string): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl}/models`, { signal: AbortSignal.timeout(800) });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Reads the provider and model catalog.
 *
 * Providers come from `config.toml` (`[model_providers.*]`), which the server
 * exposes through `config/read`. `model/list` only knows the first-party
 * catalog whatever provider is selected, so every other provider is asked
 * directly: the picker lists what the key can actually use, not somebody else's
 * models.
 */
export class ProviderRegistry {
  private providerCache: ProviderInfo[] | undefined;
  private modelCache = new Map<string, ModelChoice[]>();

  constructor(
    private readonly client: AppServerClient,
    private readonly logger: Logger,
  ) {}

  invalidate(): void {
    this.providerCache = undefined;
    this.modelCache.clear();
  }

  async listProviders(cwd?: string): Promise<ProviderInfo[]> {
    if (this.providerCache) {
      return this.providerCache;
    }

    const merged = new Map<string, ProviderInfo>();
    for (const provider of BUILT_IN_PROVIDERS) {
      merged.set(provider.id, provider);
    }
    try {
      const response = await this.client.request("config/read", {
        includeLayers: false,
        cwd: cwd ?? null,
      });
      const raw = (response.config as Record<string, unknown>).model_providers;
      if (raw && typeof raw === "object") {
        for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
          if (!value || typeof value !== "object") {
            continue;
          }
          const entry = value as Record<string, unknown>;
          const builtIn = merged.get(id);
          // Config entries win on name and URL.
          merged.set(id, {
            id,
            name: typeof entry.name === "string" ? entry.name : (builtIn?.name ?? id),
            baseUrl: typeof entry.base_url === "string" ? entry.base_url : (builtIn?.baseUrl ?? null),
            envKey: typeof entry.env_key === "string" ? entry.env_key : (builtIn?.envKey ?? null),
            builtIn: builtIn?.builtIn ?? false,
            kind: builtIn?.kind ?? "apiKey",
          });
        }
      }
    } catch (error) {
      this.logger.warn(
        `could not read model_providers from config.toml; falling back to built-ins (${
          error instanceof Error ? error.message : String(error)
        })`,
      );
    }

    this.providerCache = [...merged.values()];
    return this.providerCache;
  }

  /** The provider `config.toml` selects, for when the extension has not picked one. */
  async configuredDefaults(cwd?: string): Promise<{ provider: string | null; model: string | null }> {
    try {
      const response = await this.client.request("config/read", {
        includeLayers: false,
        cwd: cwd ?? null,
      });
      const config = response.config as Record<string, unknown>;
      return {
        provider: typeof config.model_provider === "string" ? config.model_provider : null,
        model: typeof config.model === "string" ? config.model : null,
      };
    } catch {
      return { provider: null, model: null };
    }
  }

  /** Lists the models `provider` offers. Throws with a readable reason. */
  async listModels(provider: ProviderInfo | null, apiKey?: string): Promise<ModelChoice[]> {
    const key = provider?.id ?? "default";
    const cached = this.modelCache.get(key);
    if (cached) {
      return cached;
    }

    const usesServerCatalog = !provider || provider.id === "openai" || provider.id === "ditfa";
    const models =
      usesServerCatalog || !provider?.baseUrl
        ? await this.listServerModels()
        : await this.listRemoteModels(provider, apiKey);
    this.modelCache.set(key, models);
    return models;
  }

  private async listServerModels(): Promise<ModelChoice[]> {
    const models: Model[] = [];
    let cursor: string | null = null;
    do {
      const page: ModelListResponse = await this.client.request("model/list", {
        cursor,
        limit: 100,
        includeHidden: false,
      });
      models.push(...page.data);
      cursor = page.nextCursor;
      // Defensive: a server that keeps returning the same cursor would loop.
    } while (cursor && models.length < 500);

    return models.map((model) => ({
      id: model.model,
      label: model.displayName || model.model,
      description: model.description || null,
      efforts: model.supportedReasoningEfforts.map((option) => option.reasoningEffort),
      isDefault: model.isDefault,
    }));
  }

  private async listRemoteModels(provider: ProviderInfo, apiKey?: string): Promise<ModelChoice[]> {
    const headers: Record<string, string> = {};
    if (apiKey) {
      headers.Authorization = `Bearer ${apiKey}`;
      if (provider.id === "anthropic") {
        headers["x-api-key"] = apiKey;
        headers["anthropic-version"] = "2023-06-01";
      }
    }

    let response: Response;
    try {
      response = await fetch(`${provider.baseUrl}/models`, {
        headers,
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch {
      throw new Error(
        provider.kind === "local"
          ? `${provider.name} is not running on ${provider.baseUrl}.`
          : `Could not reach ${provider.name}.`,
      );
    }
    if (response.status === 401 || response.status === 403) {
      throw new Error(`${provider.name} rejected the API key.`);
    }
    if (!response.ok) {
      throw new Error(`${provider.name} answered HTTP ${response.status}.`);
    }
    return parseModelList(await response.json());
  }
}
