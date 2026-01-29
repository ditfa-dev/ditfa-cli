import type { AppServerClient } from "../client/appServerClient";
import type { Model } from "../protocol";
import type { ModelListResponse } from "../protocol/generated/v2/ModelListResponse";
import type { Logger } from "../util/logger";

export interface ProviderInfo {
  id: string;
  name: string;
  baseUrl: string | null;
  /** Env var the provider reads its key from, when it uses one. */
  envKey: string | null;
  /** True when ditfa ships an adapter for this provider out of the box. */
  builtIn: boolean;
}

/**
 * Providers ditfa supports without any `config.toml` entry. Users can override
 * or extend these with `[model_providers.*]`.
 */
const BUILT_IN_PROVIDERS: ProviderInfo[] = [
  { id: "openai", name: "OpenAI", baseUrl: null, envKey: "OPENAI_API_KEY", builtIn: true },
  { id: "anthropic", name: "Anthropic", baseUrl: null, envKey: "ANTHROPIC_API_KEY", builtIn: true },
  { id: "gemini", name: "Google Gemini", baseUrl: null, envKey: "GEMINI_API_KEY", builtIn: true },
  {
    id: "ollama",
    name: "Ollama (local)",
    baseUrl: "http://localhost:11434/v1",
    envKey: null,
    builtIn: true,
  },
  {
    id: "lmstudio",
    name: "LM Studio (local)",
    baseUrl: "http://localhost:1234/v1",
    envKey: null,
    builtIn: true,
  },
];

/**
 * Reads the provider and model catalog from the running app-server.
 *
 * Providers come from `config.toml` (`[model_providers.*]`), which the server
 * exposes through `config/read`. Models come from `model/list`, which reflects
 * the catalog for the *currently configured* provider — so for a provider the
 * user has not switched to yet the picker also accepts a typed model name.
 */
export class ProviderRegistry {
  private providerCache: ProviderInfo[] | undefined;
  private modelCache = new Map<string, Model[]>();

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

    const configured = new Map<string, ProviderInfo>();
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
          configured.set(id, {
            id,
            name: typeof entry.name === "string" ? entry.name : id,
            baseUrl: typeof entry.base_url === "string" ? entry.base_url : null,
            envKey: typeof entry.env_key === "string" ? entry.env_key : null,
            builtIn: false,
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

    // Config entries win on name and URL; built-ins fill in the rest so a fresh
    // install still shows something useful.
    const merged = new Map<string, ProviderInfo>();
    for (const provider of BUILT_IN_PROVIDERS) {
      merged.set(provider.id, provider);
    }
    for (const [id, provider] of configured) {
      const builtIn = merged.get(id);
      merged.set(id, { ...provider, builtIn: builtIn?.builtIn ?? false });
    }

    this.providerCache = [...merged.values()].sort((a, b) => a.name.localeCompare(b.name));
    return this.providerCache;
  }

  /** Lists models known to the server, following pagination to the end. */
  async listModels(providerId: string): Promise<Model[]> {
    const cached = this.modelCache.get(providerId);
    if (cached) {
      return cached;
    }

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

    this.modelCache.set(providerId, models);
    return models;
  }
}
