import * as vscode from "vscode";

import type { ReasoningEffort } from "../protocol";
import { readSettings, updateSetting } from "../util/settings";
import type { ProviderRegistry } from "./providerRegistry";

interface ProviderPick extends vscode.QuickPickItem {
  providerId: string;
}

interface ModelPick extends vscode.QuickPickItem {
  modelId: string | null;
  efforts: ReasoningEffort[];
}

/**
 * Provider picker. Writes `ditfa.provider` and clears `ditfa.model`, since a
 * model name is only meaningful relative to its provider.
 */
export async function pickProvider(registry: ProviderRegistry, cwd?: string): Promise<boolean> {
  const current = readSettings().provider;
  const providers = await registry.listProviders(cwd);

  const items: ProviderPick[] = providers.map((provider) => ({
    providerId: provider.id,
    label: provider.name,
    description: provider.id === current ? "$(check) current" : provider.id,
    detail: [provider.baseUrl, provider.envKey ? `key: $${provider.envKey}` : null]
      .filter(Boolean)
      .join("  ·  "),
  }));

  items.unshift({
    providerId: "",
    label: "Default",
    description: current === "" ? "$(check) current" : undefined,
    detail: "Use the provider configured in ~/.ditfa/config.toml",
  });

  const picked = await vscode.window.showQuickPick(items, {
    title: "Ditfa: Select Provider",
    placeHolder: "Choose the model provider for new threads",
    matchOnDescription: true,
    matchOnDetail: true,
  });
  if (!picked) {
    return false;
  }

  await updateSetting("provider", picked.providerId);
  await updateSetting("model", "");
  registry.invalidate();
  return true;
}

/**
 * Model picker, with reasoning effort as a follow-up step for models that
 * support more than one. Falls back to free-text entry so a provider whose
 * catalog the server cannot enumerate is still usable.
 */
export async function pickModel(registry: ProviderRegistry): Promise<boolean> {
  const settings = readSettings();
  const providerId = settings.provider || "default";

  const items: ModelPick[] = [];
  try {
    const models = await registry.listModels(providerId);
    for (const model of models) {
      items.push({
        modelId: model.model,
        efforts: model.supportedReasoningEfforts.map((option) => option.reasoningEffort),
        label: model.displayName || model.model,
        description: [
          model.model === settings.model ? "$(check) current" : undefined,
          model.isDefault ? "default" : undefined,
        ]
          .filter(Boolean)
          .join("  ·  "),
        detail: model.description || undefined,
      });
    }
  } catch (error) {
    void vscode.window.showWarningMessage(
      `Could not list models: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  items.push({
    modelId: null,
    efforts: [],
    label: "$(edit) Enter a model name…",
    detail: "For providers whose catalog ditfa cannot enumerate, such as a local Ollama model",
  });

  const picked = await vscode.window.showQuickPick(items, {
    title: `Ditfa: Select Model${settings.provider ? ` (${settings.provider})` : ""}`,
    placeHolder: "Choose the model for new threads",
    matchOnDescription: true,
    matchOnDetail: true,
  });
  if (!picked) {
    return false;
  }

  let modelId = picked.modelId;
  if (modelId === null) {
    const typed = await vscode.window.showInputBox({
      title: "Ditfa: Model Name",
      prompt: "Model identifier as the provider expects it",
      value: settings.model,
      placeHolder: "llama3.1:70b",
    });
    if (typed === undefined) {
      return false;
    }
    modelId = typed.trim();
  }

  await updateSetting("model", modelId);

  if (picked.efforts.length > 1) {
    const effort = await vscode.window.showQuickPick(
      picked.efforts.map((value) => ({
        label: value,
        description: value === settings.reasoningEffort ? "$(check) current" : undefined,
      })),
      { title: "Ditfa: Reasoning Effort", placeHolder: "Higher effort is slower but more thorough" },
    );
    if (effort) {
      await updateSetting("reasoningEffort", effort.label);
    }
  }

  return true;
}

/** Approval policy and sandbox mode, presented together as one "how much rope" choice. */
export async function pickApprovalMode(): Promise<boolean> {
  const settings = readSettings();

  const modes = [
    {
      label: "Read only",
      detail: "The agent can read and plan, but cannot write files or run commands",
      approvalPolicy: "untrusted" as const,
      sandboxMode: "read-only" as const,
    },
    {
      label: "Approve on request",
      detail: "The agent works inside the workspace and asks before stepping outside the sandbox",
      approvalPolicy: "on-request" as const,
      sandboxMode: "workspace-write" as const,
    },
    {
      label: "Approve everything",
      detail: "Ask before every command, even sandboxed ones",
      approvalPolicy: "untrusted" as const,
      sandboxMode: "workspace-write" as const,
    },
    {
      label: "Full access (no sandbox)",
      detail: "No prompts, no sandbox. Only use in a container or a workspace you can throw away",
      approvalPolicy: "never" as const,
      sandboxMode: "danger-full-access" as const,
    },
  ];

  const picked = await vscode.window.showQuickPick(
    modes.map((mode) => ({
      ...mode,
      description:
        mode.approvalPolicy === settings.approvalPolicy && mode.sandboxMode === settings.sandboxMode
          ? "$(check) current"
          : undefined,
    })),
    { title: "Ditfa: Approval Mode", placeHolder: "How much should the agent do without asking?" },
  );
  if (!picked) {
    return false;
  }

  if (picked.sandboxMode === "danger-full-access") {
    const confirmed = await vscode.window.showWarningMessage(
      "Full access removes the sandbox. The agent can run any command and modify any file this account can reach.",
      { modal: true },
      "Enable full access",
    );
    if (confirmed !== "Enable full access") {
      return false;
    }
  }

  await updateSetting("approvalPolicy", picked.approvalPolicy);
  await updateSetting("sandboxMode", picked.sandboxMode);
  return true;
}
