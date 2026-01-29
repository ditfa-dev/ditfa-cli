import * as vscode from "vscode";

export type LogLevel = "error" | "warn" | "info" | "debug" | "trace";

const LEVEL_ORDER: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
  trace: 4,
};

/**
 * Output-channel logger. Level is read from `ditfa.logLevel` and re-read on
 * configuration change so raising verbosity does not require a reload.
 */
export class Logger implements vscode.Disposable {
  private readonly channel: vscode.OutputChannel;
  private level: LogLevel;
  private readonly subscription: vscode.Disposable;

  constructor(name = "Ditfa Code") {
    this.channel = vscode.window.createOutputChannel(name);
    this.level = readLevel();
    this.subscription = vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("ditfa.logLevel")) {
        this.level = readLevel();
      }
    });
  }

  error(message: string, error?: unknown): void {
    this.write("error", error ? `${message}: ${describeError(error)}` : message);
  }

  warn(message: string): void {
    this.write("warn", message);
  }

  info(message: string): void {
    this.write("info", message);
  }

  debug(message: string): void {
    this.write("debug", message);
  }

  /** Raw protocol traffic. Very noisy — only emitted at `trace`. */
  trace(direction: "->" | "<-", payload: string): void {
    this.write("trace", `${direction} ${truncate(payload, 4000)}`);
  }

  show(): void {
    this.channel.show(true);
  }

  dispose(): void {
    this.subscription.dispose();
    this.channel.dispose();
  }

  private write(level: LogLevel, message: string): void {
    if (LEVEL_ORDER[level] > LEVEL_ORDER[this.level]) {
      return;
    }
    const stamp = new Date().toISOString().slice(11, 23);
    this.channel.appendLine(`[${stamp}] [${level}] ${message}`);
  }
}

function readLevel(): LogLevel {
  const configured = vscode.workspace.getConfiguration("ditfa").get<string>("logLevel", "info");
  return configured in LEVEL_ORDER ? (configured as LogLevel) : "info";
}

export function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? `${error.name}: ${error.message}`;
  }
  if (typeof error === "string") {
    return error;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}… (${value.length} bytes)`;
}
