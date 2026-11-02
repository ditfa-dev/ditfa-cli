import * as vscode from "vscode";

import type { ApiKeys } from "../account/apiKeys";
import { parseModelList, probeLocal, type ProviderInfo } from "../providers/providerRegistry";
import { updateSetting } from "../util/settings";
import type { CompletionHost } from "./inlineProvider";
import { keyName, pickLocalModel, resolveTarget, type TargetResult } from "./target";

export interface SetupDeps {
  keys: ApiKeys;
  providers(): Promise<ProviderInfo[]>;
  /** The provider and model the chat uses, as a starting point. */
  chatProvider(): string | null;
  chatModel(): string;
}

const MODEL_LIST_TIMEOUT_MS = 6_000;
const MANUAL = "$(edit) Type a model id…";

/** Connects Tab autocomplete to the keys and providers the rest of the extension knows. */
export class CompletionSetup implements CompletionHost {
  constructor(private readonly deps: SetupDeps) {}

  async resolveTarget(): Promise<TargetResult> {
    const config = vscode.workspace.getConfiguration("ditfa");
    return resolveTarget({
      preferences: {
        provider: config.get<string>("completion.provider", "").trim(),
        model: config.get<string>("completion.model", "").trim(),
      },
      chatProvider: this.deps.chatProvider(),
      chatModel: this.deps.chatModel(),
      providers: await this.deps.providers(),
      storedKey: (name) => this.deps.keys.get(name),
      env: process.env,
      localModels: async (baseUrl) => (await fetchModels(baseUrl)) ?? [],
    });
  }

  async setup(): Promise<void> {
    const providers = (await this.deps.providers()).filter((provider) => provider.baseUrl);
    const items = await Promise.all(
      providers.map(async (provider) => ({
        label: provider.name,
        description: await this.describe(provider),
        provider,
      })),
    );
    const picked = await vscode.window.showQuickPick(items, {
      title: "Tab autocomplete: provider",
      placeHolder: "Where should suggestions come from? Pick something fast.",
      ignoreFocusOut: true,
    });
    if (!picked) {
      return;
    }
    const provider = picked.provider;

    let apiKey: string | undefined;
    if (provider.kind !== "local") {
      const name = keyName(provider);
      apiKey = (await this.deps.keys.get(name)) || process.env[name];
      if (!apiKey) {
        apiKey = await vscode.window.showInputBox({
          title: `${provider.name} API key`,
          prompt:
            provider.id === "ditfa"
              ? "Tab autocomplete calls the API directly, so it needs an API key, not the browser sign-in. Create one at chat.ditfa.com/api-keys. Stored in your system keychain."
              : provider.keyUrl
                ? `Stored in your system keychain. Create one at ${provider.keyUrl}`
                : "Stored in your system keychain",
          password: true,
          ignoreFocusOut: true,
          validateInput: (value) => (value.trim().length === 0 ? "Enter an API key" : undefined),
        });
        if (!apiKey) {
          return;
        }
        apiKey = apiKey.trim();
        await this.deps.keys.set(name, apiKey);
      }
    }

    const model = await this.chooseModel(provider, apiKey);
    if (!model) {
      return;
    }

    await updateSetting("completion.provider", provider.id);
    await updateSetting("completion.model", model);
    await updateSetting("completion.enabled", true);
    void vscode.window.showInformationMessage(
      `Tab autocomplete is on. Suggestions come from ${provider.name} (${model}); press Tab to accept one.`,
    );
  }

  private async describe(provider: ProviderInfo): Promise<string> {
    if (provider.kind === "local") {
      return (await probeLocal(provider.baseUrl ?? "")) ? "running on this machine" : "not running";
    }
    return (await this.deps.keys.get(keyName(provider))) ? "key saved" : "needs an API key";
  }

  private async chooseModel(provider: ProviderInfo, apiKey: string | undefined): Promise<string | undefined> {
    const listed = await fetchModels(provider.baseUrl ?? "", apiKey, provider.id);
    const manual = async () =>
      (
        await vscode.window.showInputBox({
          title: "Tab autocomplete: model",
          prompt: "The model id to use. A small, fast model keeps suggestions quick.",
          value: this.deps.chatModel(),
          ignoreFocusOut: true,
        })
      )?.trim();
    if (!listed || listed.length === 0) {
      return manual();
    }

    const suggested = provider.kind === "local" ? pickLocalModel(listed) : null;
    const choice = await vscode.window.showQuickPick(
      [
        ...listed.map((id) => ({ label: id, description: id === suggested ? "suggested" : undefined })),
        { label: MANUAL, description: undefined },
      ].sort((a, b) => Number(b.description === "suggested") - Number(a.description === "suggested")),
      {
        title: "Tab autocomplete: model",
        placeHolder: "Pick a small, fast model: suggestions should arrive in about a second.",
        matchOnDescription: true,
        ignoreFocusOut: true,
      },
    );
    if (!choice) {
      return undefined;
    }
    return choice.label === MANUAL ? manual() : choice.label;
  }
}

/** The model ids a provider offers, or null when it cannot be asked. */
async function fetchModels(baseUrl: string, apiKey?: string, providerId?: string): Promise<string[] | null> {
  if (!baseUrl) {
    return null;
  }
  const headers: Record<string, string> = {};
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
    if (providerId === "anthropic") {
      headers["x-api-key"] = apiKey;
      headers["anthropic-version"] = "2023-06-01";
    }
  }
  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/models`, {
      headers,
      signal: AbortSignal.timeout(apiKey ? MODEL_LIST_TIMEOUT_MS : 1_500),
    });
    if (!response.ok) {
      return null;
    }
    return parseModelList(await response.json()).map((model) => model.id);
  } catch {
    return null;
  }
}
