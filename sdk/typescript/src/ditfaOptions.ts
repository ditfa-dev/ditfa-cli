export type DitfaConfigValue = string | number | boolean | DitfaConfigValue[] | DitfaConfigObject;

export type DitfaConfigObject = { [key: string]: DitfaConfigValue };

export type DitfaOptions = {
  ditfaPathOverride?: string;
  baseUrl?: string;
  apiKey?: string;
  /**
   * Additional `--config key=value` overrides to pass to the Ditfa CLI.
   *
   * Provide a JSON object and the SDK will flatten it into dotted paths and
   * serialize values as TOML literals so they are compatible with the CLI's
   * `--config` parsing.
   */
  config?: DitfaConfigObject;
  /**
   * Environment variables passed to the Ditfa CLI process. When provided, the SDK
   * will not inherit variables from `process.env`.
   */
  env?: Record<string, string>;
};
