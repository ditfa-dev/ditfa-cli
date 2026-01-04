import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as vscode from "vscode";

import {
  isFailure,
  isNotification,
  isRequest,
  isSuccess,
  type JsonRpcErrorBody,
  type JsonRpcMessage,
  type RequestId,
  type RequestMethod,
  type RequestParams,
  type RequestResult,
  type ServerNotification,
  type ServerRequest,
} from "../protocol";
import type { Logger } from "../util/logger";

export class AppServerError extends Error {
  constructor(
    readonly method: string,
    readonly rpc: JsonRpcErrorBody,
  ) {
    super(`${method} failed: ${rpc.message}`);
    this.name = "AppServerError";
  }
}

export class AppServerClosedError extends Error {
  constructor(message = "The ditfa app-server connection is closed.") {
    super(message);
    this.name = "AppServerClosedError";
  }
}

/** Result a server-initiated request handler resolves to, or an error to return. */
export type ServerRequestHandler = (request: ServerRequest) => Promise<unknown>;

export interface AppServerOptions {
  executable: string;
  cwd?: string;
  ditfaHome?: string;
  env?: Record<string, string>;
  clientVersion: string;
  logger: Logger;
}

interface Pending {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}

const CLIENT_NAME = "ditfa_vscode";
const CLIENT_TITLE = "Ditfa Code VS Code Extension";

/**
 * Owns the `ditfa app-server` child process and the JSON-RPC conversation with it.
 *
 * The wire format is newline-delimited JSON with the `"jsonrpc":"2.0"` member
 * omitted, so framing is one message per line and dispatch keys off which of
 * `id` / `method` / `result` / `error` are present.
 */
export class AppServerClient implements vscode.Disposable {
  private readonly pending = new Map<RequestId, Pending>();
  private readonly notificationEmitter = new vscode.EventEmitter<ServerNotification>();
  private readonly exitEmitter = new vscode.EventEmitter<{ code: number | null; signal: string | null }>();

  private child: ChildProcessWithoutNullStreams | undefined;
  private serverRequestHandler: ServerRequestHandler | undefined;
  private stdoutBuffer = "";
  private nextId = 1;
  private closed = false;

  readonly onNotification = this.notificationEmitter.event;
  readonly onExit = this.exitEmitter.event;

  private constructor(private readonly options: AppServerOptions) {}

  /**
   * Spawns the server and completes the mandatory `initialize` / `initialized`
   * handshake. Resolves only once the server is ready for other methods.
   */
  static async start(options: AppServerOptions): Promise<AppServerClient> {
    const client = new AppServerClient(options);
    await client.spawnProcess();
    await client.handshake();
    return client;
  }

  setServerRequestHandler(handler: ServerRequestHandler): void {
    this.serverRequestHandler = handler;
  }

  get isRunning(): boolean {
    return !this.closed && this.child !== undefined && this.child.exitCode === null;
  }

  async request<M extends RequestMethod>(
    method: M,
    params: RequestParams<M>,
  ): Promise<RequestResult<M>> {
    if (!this.isRunning) {
      throw new AppServerClosedError();
    }
    const id = this.nextId++;
    const payload: Record<string, unknown> = { id, method };
    if (params !== undefined) {
      payload.params = params;
    }

    return new Promise<RequestResult<M>>((resolve, reject) => {
      this.pending.set(id, {
        method,
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      try {
        this.send(payload);
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  notify(method: string, params?: unknown): void {
    if (!this.isRunning) {
      return;
    }
    const payload: Record<string, unknown> = { method };
    if (params !== undefined) {
      payload.params = params;
    }
    this.send(payload);
  }

  dispose(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.rejectAllPending(new AppServerClosedError("Ditfa Code was shut down."));
    this.notificationEmitter.dispose();
    this.exitEmitter.dispose();
    const child = this.child;
    this.child = undefined;
    if (child && child.exitCode === null) {
      // SIGTERM lets the server flush rollout state; SIGKILL is the backstop.
      child.kill("SIGTERM");
      const pid = child.pid;
      setTimeout(() => {
        if (pid !== undefined && child.exitCode === null) {
          child.kill("SIGKILL");
        }
      }, 3000).unref?.();
    }
  }

  private async spawnProcess(): Promise<void> {
    const { executable, cwd, ditfaHome, env, logger } = this.options;

    const childEnv: NodeJS.ProcessEnv = { ...process.env, ...env };
    if (ditfaHome) {
      childEnv.DITFA_HOME = ditfaHome;
    }
    // The server should stream plain JSON, never ANSI-decorated output.
    childEnv.NO_COLOR = "1";

    logger.info(`spawning: ${executable} app-server --listen stdio://`);
    const child = spawn(executable, ["app-server", "--listen", "stdio://"], {
      cwd,
      env: childEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.child = child;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (chunk: string) => this.consumeStdout(chunk));
    child.stderr.on("data", (chunk: string) => {
      for (const line of chunk.split("\n")) {
        if (line.trim()) {
          logger.debug(`[app-server] ${line.trimEnd()}`);
        }
      }
    });

    child.on("error", (error) => {
      logger.error("app-server process error", error);
      this.rejectAllPending(error);
    });

    child.on("exit", (code, signal) => {
      logger.warn(`app-server exited (code=${code ?? "null"}, signal=${signal ?? "null"})`);
      this.rejectAllPending(
        new AppServerClosedError(`The ditfa app-server exited (code ${code ?? "null"}).`),
      );
      if (!this.closed) {
        this.exitEmitter.fire({ code, signal });
      }
    });

    await new Promise<void>((resolve, reject) => {
      const onSpawn = () => {
        child.off("error", onError);
        resolve();
      };
      const onError = (error: Error) => {
        child.off("spawn", onSpawn);
        reject(error);
      };
      child.once("spawn", onSpawn);
      child.once("error", onError);
    });
  }

  private async handshake(): Promise<void> {
    const response = await this.request("initialize", {
      clientInfo: {
        name: CLIENT_NAME,
        title: CLIENT_TITLE,
        version: this.options.clientVersion,
      },
      capabilities: {
        // The extension renders account, provider, and permission-profile data
        // that live behind the experimental surface.
        experimentalApi: true,
        requestAttestation: false,
        // Realtime audio and raw response mirroring are pure overhead here.
        optOutNotificationMethods: [
          "rawResponse/completed",
          "rawResponseItem/completed",
          "thread/realtime/outputAudio/delta",
          "thread/realtime/transcript/delta",
        ],
      },
    });

    this.notify("initialized");
    this.options.logger.info(
      `app-server ready — ${response.userAgent} (${response.platformOs}), home ${response.codexHome}`,
    );
  }

  private consumeStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    let newline = this.stdoutBuffer.indexOf("\n");
    while (newline !== -1) {
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (line) {
        this.handleLine(line);
      }
      newline = this.stdoutBuffer.indexOf("\n");
    }
  }

  private handleLine(line: string): void {
    this.options.logger.trace("<-", line);
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch (error) {
      this.options.logger.error(`unparseable line from app-server: ${line}`, error);
      return;
    }

    if (isSuccess(message)) {
      this.settle(message.id, (pending) => pending.resolve(message.result));
      return;
    }
    if (isFailure(message)) {
      this.settle(message.id, (pending) =>
        pending.reject(new AppServerError(pending.method, message.error)),
      );
      return;
    }
    if (isRequest(message)) {
      void this.handleServerRequest(message.id, message as unknown as ServerRequest);
      return;
    }
    if (isNotification(message)) {
      this.notificationEmitter.fire(message as unknown as ServerNotification);
      return;
    }
    this.options.logger.warn(`ignoring unrecognized message: ${line}`);
  }

  private settle(id: RequestId, apply: (pending: Pending) => void): void {
    const pending = this.pending.get(id);
    if (!pending) {
      this.options.logger.warn(`response for unknown request id ${String(id)}`);
      return;
    }
    this.pending.delete(id);
    apply(pending);
  }

  private async handleServerRequest(id: RequestId, request: ServerRequest): Promise<void> {
    const handler = this.serverRequestHandler;
    if (!handler) {
      this.send({
        id,
        error: { code: -32601, message: `No handler registered for ${request.method}` },
      });
      return;
    }
    try {
      const result = await handler(request);
      this.send({ id, result: result ?? {} });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.options.logger.error(`server request ${request.method} failed`, error);
      this.send({ id, error: { code: -32000, message } });
    }
  }

  private send(payload: unknown): void {
    const child = this.child;
    if (!child || child.stdin.destroyed) {
      throw new AppServerClosedError();
    }
    const line = `${JSON.stringify(payload)}\n`;
    this.options.logger.trace("->", line.trimEnd());
    child.stdin.write(line);
  }

  private rejectAllPending(error: unknown): void {
    const entries = [...this.pending.values()];
    this.pending.clear();
    for (const pending of entries) {
      pending.reject(error);
    }
  }
}
