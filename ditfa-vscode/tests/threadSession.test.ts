import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AppServerClient } from "../src/client/appServerClient";
import type { ServerNotification } from "../src/protocol";
import { ThreadSession, type TurnOptions } from "../src/session/threadSession";
import type { TranscriptStore } from "../src/session/transcriptStore";
import type { ChatEntry } from "../src/session/types";
import type { Logger } from "../src/util/logger";

const logger = { info() {}, debug() {}, warn() {}, error() {} } as unknown as Logger;
const options = {
  settings: { model: "", reasoningEffort: null, approvalPolicy: "on-request", provider: "", sandboxMode: "workspace-write" },
  sandboxPolicy: { type: "dangerFullAccess" },
} as unknown as TurnOptions;

const THREAD = "t1";
const threadResponse = {
  thread: { id: THREAD, name: null, turns: [] },
  cwd: "/w",
  model: "m",
  modelProvider: "p",
  reasoningEffort: null,
};

function notify(session: ThreadSession, method: string, params: Record<string, unknown>): void {
  session.handleNotification({ method, params: { threadId: THREAD, ...params } } as unknown as ServerNotification);
}

const turn = (id: string, extra: Record<string, unknown> = {}) => ({
  turn: { id, items: [], status: "completed", error: null, durationMs: 10, ...extra },
});

describe("ThreadSession", () => {
  let request: ReturnType<typeof vi.fn>;
  let session: ThreadSession;
  let store: { load: ReturnType<typeof vi.fn>; save: ReturnType<typeof vi.fn> };

  const entries = () => session.snapshot().entries;

  beforeEach(async () => {
    request = vi.fn(async (method: string) => (method === "thread/start" ? threadResponse : {}));
    store = { load: vi.fn(async () => null), save: vi.fn(async () => undefined) };
    session = new ThreadSession(
      { request } as unknown as AppServerClient,
      logger,
      store as unknown as TranscriptStore,
    );
    await session.start(options.settings, "/w");
  });

  const send = async (text = "hi") => {
    await session.send({ text, attachments: ["a.ts"] }, [{ type: "text", text, text_elements: [] }], options);
    const call = request.mock.calls.find(([method]) => method === "turn/start");
    return (call?.[1] as { clientUserMessageId: string }).clientUserMessageId;
  };

  it("replaces the local echo with the server's message instead of showing both", async () => {
    const clientId = await send();
    expect(entries()).toHaveLength(1);

    notify(session, "turn/started", turn("turn1"));
    const item = {
      type: "userMessage",
      id: "server-id",
      clientId,
      content: [{ type: "text", text: "hi", text_elements: [] }],
    };
    notify(session, "item/started", { item, turnId: "turn1" });
    notify(session, "item/completed", { item, turnId: "turn1" });

    expect(entries()).toHaveLength(1);
    expect(entries()[0]).toMatchObject({ id: "server-id", turnId: "turn1", attachments: ["a.ts"] });
  });

  it("reports a turn as active from the moment it is requested", async () => {
    request.mockImplementationOnce(() => new Promise(() => undefined));
    void session.send({ text: "x", attachments: [] }, [], options);
    expect(session.turnActive).toBe(true);
  });

  it("removes the echo and clears the turn when it could not start", async () => {
    request.mockRejectedValueOnce(new Error("nope"));
    await expect(send()).rejects.toThrow("nope");
    expect(entries()).toHaveLength(0);
    expect(session.turnActive).toBe(false);
  });

  it("measures context from the last request, not the running total", () => {
    notify(session, "thread/tokenUsage/updated", {
      tokenUsage: {
        total: { totalTokens: 900_000 },
        last: { totalTokens: 50_000 },
        modelContextWindow: 100_000,
      },
    });
    expect(session.snapshot().tokenUsage).toMatchObject({ used: 50_000, total: 900_000, percentUsed: 50 });
  });

  it("shows one row for a whole retry sequence and clears it on recovery", () => {
    notify(session, "turn/started", turn("turn1"));
    for (const attempt of [1, 2, 3]) {
      notify(session, "error", {
        turnId: "turn1",
        willRetry: true,
        error: { message: `Reconnecting... ${attempt}/5`, ditfaErrorInfo: null, additionalDetails: null },
      });
    }
    expect(entries().filter((entry) => entry.kind === "error")).toHaveLength(1);
    expect(entries()[0]).toMatchObject({ message: "Reconnecting... 3/5", retrying: true });

    notify(session, "item/agentMessage/delta", { itemId: "m1", turnId: "turn1", delta: "ok" });
    expect(entries().filter((entry) => entry.kind === "error")).toHaveLength(0);
  });

  it("does not repeat a fatal error when turn/completed restates it", () => {
    notify(session, "turn/started", turn("turn1"));
    const error = { message: "boom", ditfaErrorInfo: "other", additionalDetails: null };
    notify(session, "error", { turnId: "turn1", willRetry: false, error });
    notify(session, "turn/completed", turn("turn1", { status: "failed", error }));
    expect(entries().filter((entry) => entry.kind === "error")).toHaveLength(1);
  });

  it("suggests signing in when the provider rejects the credentials", () => {
    notify(session, "turn/started", turn("turn1"));
    notify(session, "error", {
      turnId: "turn1",
      willRetry: false,
      error: { message: "401", ditfaErrorInfo: "unauthorized", additionalDetails: null },
    });
    expect(entries()[0]).toMatchObject({ kind: "error", action: "signIn" });
  });

  it("flags a command repeated until it is clearly a loop", () => {
    const seen: string[] = [];
    session.onLoopDetected((command) => seen.push(command));
    notify(session, "turn/started", turn("turn1"));
    for (let index = 0; index < 7; index += 1) {
      notify(session, "item/started", {
        turnId: "turn1",
        item: {
          type: "commandExecution",
          id: `c${index}`,
          command: "npm test",
          cwd: "/w",
          status: "inProgress",
          commandActions: [],
          aggregatedOutput: null,
          exitCode: null,
          durationMs: null,
        },
      });
    }
    expect(seen).toEqual(["npm test"]);
  });

  it("caps command output so a noisy build cannot grow without bound", () => {
    notify(session, "turn/started", turn("turn1"));
    notify(session, "item/started", {
      turnId: "turn1",
      item: {
        type: "commandExecution",
        id: "c1",
        command: "x",
        cwd: "/w",
        status: "inProgress",
        commandActions: [],
        aggregatedOutput: null,
        exitCode: null,
        durationMs: null,
      },
    });
    for (let index = 0; index < 30; index += 1) {
      notify(session, "item/commandExecution/outputDelta", { itemId: "c1", delta: "x".repeat(10_000) });
    }
    const entry = entries()[0] as Extract<ChatEntry, { kind: "command" }>;
    expect(entry.output.length).toBeLessThanOrEqual(200_000);
  });

  it("marks a command left running as stopped when the turn ends", () => {
    notify(session, "turn/started", turn("turn1"));
    notify(session, "item/started", {
      turnId: "turn1",
      item: {
        type: "commandExecution",
        id: "c1",
        command: "x",
        cwd: "/w",
        status: "inProgress",
        commandActions: [],
        aggregatedOutput: null,
        exitCode: null,
        durationMs: null,
      },
    });
    notify(session, "turn/completed", turn("turn1", { status: "interrupted" }));
    expect(entries()[0]).toMatchObject({ status: "aborted" });
  });

  it("saves the transcript when a turn ends", () => {
    notify(session, "turn/started", turn("turn1"));
    notify(session, "turn/completed", turn("turn1"));
    expect(store.save).toHaveBeenCalledOnce();
  });

  it("rewinds the conversation and drops the turns after a checkpoint", async () => {
    for (const id of ["turn1", "turn2", "turn3"]) {
      notify(session, "turn/started", turn(id));
      notify(session, "item/completed", {
        turnId: id,
        item: { type: "agentMessage", id: `m-${id}`, text: id, phase: null },
      });
      notify(session, "turn/completed", turn(id));
    }
    await session.rollbackTo("turn2");

    expect(request).toHaveBeenCalledWith("thread/rollback", { threadId: THREAD, numTurns: 2 });
    expect(entries().map((entry) => entry.id)).toEqual(["m-turn1"]);
    expect(session.latestTurnId).toBe("turn1");
  });

  it("restores rich history on resume where the server's copy is lossy", async () => {
    const stored: ChatEntry = {
      id: "c1",
      kind: "command",
      at: 1,
      turnId: "turn1",
      command: "ls",
      summary: null,
      cwd: "/w",
      status: "completed",
      output: "a",
      exitCode: 0,
      durationMs: 1,
    };
    store.load.mockResolvedValueOnce({ entries: [stored], plan: [], planExplanation: null, tokenUsage: null });
    request.mockResolvedValueOnce({
      ...threadResponse,
      thread: {
        ...threadResponse.thread,
        turns: [
          { id: "turn1", items: [], startedAt: 1 },
          {
            id: "turn2",
            startedAt: 2,
            items: [{ type: "agentMessage", id: "m2", text: "from the CLI", phase: null }],
          },
        ],
      },
    });
    await session.resume(THREAD, options.settings, "/w");
    expect(entries().map((entry) => entry.id)).toEqual(["c1", "m2"]);
  });

  describe("undone hunks", () => {
    const patch = (status: string) => ({
      type: "fileChange",
      id: "f1",
      status,
      changes: [{ path: "src/a.ts", kind: { type: "update", move_path: null }, diff: "@@ -1,1 +1,1 @@\n-a\n+b\n" }],
    });

    it("announces a change only when it lands, once", () => {
      const applied = vi.fn();
      session.onFileChangeApplied(applied);

      notify(session, "item/started", { item: patch("inProgress"), turnId: "t" });
      expect(applied).not.toHaveBeenCalled();
      notify(session, "item/completed", { item: patch("completed"), turnId: "t" });
      notify(session, "item/completed", { item: patch("completed"), turnId: "t" });
      expect(applied).toHaveBeenCalledTimes(1);
    });

    it("remembers what was undone and tells the agent once", () => {
      notify(session, "item/completed", { item: patch("completed"), turnId: "t" });
      session.markReverted("f1", "src/a.ts", [0], false, "the user undid it");

      const entry = entries().find((candidate) => candidate.id === "f1");
      expect(entry).toMatchObject({ kind: "fileChange", changes: [{ path: "src/a.ts", reverted: [0] }] });
      expect(session.takeNotes()).toEqual(["the user undid it"]);
      expect(session.takeNotes()).toEqual([]);
    });
  });
});
