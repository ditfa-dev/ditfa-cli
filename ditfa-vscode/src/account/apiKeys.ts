import type * as vscode from "vscode";

/**
 * Provider keys, kept in the OS keychain through VS Code's SecretStorage rather
 * than in a config file. They reach the engine only as environment variables on
 * the process this extension spawns.
 */
const PREFIX = "ditfa.key.";

export class ApiKeys {
  private readonly names = new Set<string>();

  constructor(private readonly secrets: vscode.SecretStorage) {}

  async set(envKey: string, value: string): Promise<void> {
    await this.secrets.store(PREFIX + envKey, value);
    this.names.add(envKey);
  }

  async get(envKey: string): Promise<string | undefined> {
    return this.secrets.get(PREFIX + envKey);
  }

  async has(envKey: string): Promise<boolean> {
    return Boolean(await this.get(envKey));
  }

  /** The environment to give the engine: every stored key for the given variables. */
  async environment(envKeys: string[]): Promise<Record<string, string>> {
    const env: Record<string, string> = {};
    for (const envKey of envKeys) {
      const value = await this.get(envKey);
      if (value) {
        env[envKey] = value;
      }
    }
    return env;
  }
}
