import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  AppServerClient,
  AppServerClosedError,
  AppServerError,
} from "../src/client/appServerClient";
import type { ServerNotification } from "../src/protocol";
import type { Logger } from "../src/util/logger";

/**
 * Drives the real client against a stand-in server over a real pipe, so framing,
 * id correlation, and the bidirectional request path are exercised end to end
 * rather than mocked away.
 *
 * The client always spawns `<executable> app-server --listen stdio://`, so the
 * fixture is reached through a shell shim that ignores those arguments. That
 * keeps the production argument handling under test.
 */
const SHIM = resolve(__dirname, "fixtures/node-shim.sh");
const FAKE_SERVER = resolve(__dirname, "fixtures/fake-app-server.mjs");

let client: AppServerClient | undefined;

afterEach(() => {
  client?.dispose();
  client = undefined;
});

describe("AppServerClient", () => {
  it("completes the initialize handshake and reports as running", async () => {
    client = await start();
    expect(client.isRunning).toBe(true);
  });

  it("correlates responses to their requests", async () => {
    client = await start();
    const response = await client.request("thread/start", { cwd: "/workspace" } as never);
    expect(response.thread.id).toBe("thread-1");
    expect(response.model).toBe("test-model");
    expect(response.cwd).toBe("/workspace");
  });

  it("keeps concurrent requests distinct", async () => {
    client = await start();
    const [first, second] = await Promise.all([
      client.request("thread/start", { cwd: "/one" } as never),
      client.request("thread/start", { cwd: "/two" } as never),
    ]);
    expect(first.cwd).toBe("/one");
    expect(second.cwd).toBe("/two");
  });

  it("surfaces JSON-RPC errors as AppServerError", async () => {
    client = await start();
    await expect(client.request("boom" as never, undefined as never)).rejects.toBeInstanceOf(
      AppServerError,
    );
  });

  it("delivers server notifications", async () => {
    client = await start();
    const notifications: ServerNotification[] = [];
    client.onNotification((notification) => notifications.push(notification));

    await client.request("thread/start", { cwd: "/workspace" } as never);
    await waitFor(() => notifications.length > 0);
    expect(notifications[0]?.method).toBe("warning");
  });

  it("answers server-initiated requests through the registered handler", async () => {
    client = await start();
    let seenMethod: string | undefined;
    client.setServerRequestHandler(async (request) => {
      seenMethod = request.method;
      return { decision: "decline" };
    });

    const response = (await client.request("provoke/approval" as never, undefined as never)) as {
      echoed: { decision: string };
    };
    expect(seenMethod).toBe("item/commandExecution/requestApproval");
    expect(response.echoed.decision).toBe("decline");
  });

  it("returns an error to the server when a handler throws", async () => {
    client = await start();
    client.setServerRequestHandler(async () => {
      throw new Error("handler said no");
    });

    const response = (await client.request("provoke/approval" as never, undefined as never)) as {
      echoed: { message: string };
    };
    expect(response.echoed.message).toBe("handler said no");
  });

  it("rejects in-flight requests when the connection closes", async () => {
    client = await start();
    const inFlight = client.request("thread/start", { cwd: "/never" } as never);
    client.dispose();
    await expect(inFlight).rejects.toBeInstanceOf(AppServerClosedError);
  });

  it("refuses new requests once disposed", async () => {
    client = await start();
    client.dispose();
    await expect(client.request("thread/start", {} as never)).rejects.toBeInstanceOf(
      AppServerClosedError,
    );
  });

  it("fails to start when the executable does not exist", async () => {
    await expect(
      AppServerClient.start({
        executable: resolve(__dirname, "fixtures/does-not-exist"),
        clientVersion: "0.0.0-test",
        logger: silentLogger(),
      }),
    ).rejects.toThrow();
  });
});

function start(): Promise<AppServerClient> {
  return AppServerClient.start({
    executable: SHIM,
    clientVersion: "0.0.0-test",
    logger: silentLogger(),
    env: { FAKE_APP_SERVER: FAKE_SERVER, NODE_BIN: process.execPath },
  });
}

function silentLogger(): Logger {
  return {
    error: () => {},
    warn: () => {},
    info: () => {},
    debug: () => {},
    trace: () => {},
    show: () => {},
    dispose: () => {},
  } as unknown as Logger;
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error("timed out waiting for condition");
    }
    await new Promise((done) => setTimeout(done, 10));
  }
}
