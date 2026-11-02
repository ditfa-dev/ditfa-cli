import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ApprovalService } from "../../src/approvals/approvalService";
import { planRevert } from "../../src/checkpoints/revert";
import { AppServerClient } from "../../src/client/appServerClient";
import { buildUserInput } from "../../src/session/promptContext";
import { ThreadSession, type TurnOptions } from "../../src/session/threadSession";
import { TranscriptStore } from "../../src/session/transcriptStore";
import type { ChatEntry } from "../../src/session/types";
import type { Logger } from "../../src/util/logger";

/**
 * Drives the real engine against a scripted model, so the protocol assumptions
 * in this extension are checked against what the binary actually does. It needs
 * `DITFA_E2E_BINARY` and permission to listen on localhost:
 *
 *   DITFA_E2E_BINARY=$(which ditfa) pnpm test tests/e2e
 */
const binary = process.env.DITFA_E2E_BINARY;

const logger = {
  info() {},
  debug() {},
  warn() {},
  error() {},
  trace() {},
} as unknown as Logger;

type Reply = Record<string, unknown>[];

const completed = (id: string) => ({
  type: "response.completed",
  response: {
    id,
    usage: {
      input_tokens: 1000,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 50,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 1050,
    },
  },
});

const toolCall = (item: Record<string, unknown>): Reply => [{ type: "response.output_item.done", item }];
const say = (text: string): Reply => [
  {
    type: "response.output_item.done",
    item: { type: "message", role: "assistant", content: [{ type: "output_text", text }] },
  },
];

describe.skipIf(!binary)("the real engine", () => {
  let server: Server;
  let root: string;
  let workspace: string;
  let client: AppServerClient;
  let session: ThreadSession;
  let approvals: ApprovalService;
  let store: TranscriptStore;
  const script: Reply[] = [];
  const requests: string[] = [];
  const prompts: string[] = [];

  const entries = () => session.snapshot().entries;
  const options = (): TurnOptions => ({
    settings: {
      model: "",
      provider: "",
      reasoningEffort: null,
      approvalPolicy: "untrusted",
      sandboxMode: "danger-full-access",
    } as unknown as TurnOptions["settings"],
    sandboxPolicy: { type: "dangerFullAccess" },
  });

  const turnDone = () =>
    new Promise<void>((resolve) => {
      const listener = session.onTurnActiveChanged((active) => {
        if (!active) {
          listener.dispose();
          resolve();
        }
      });
    });

  async function run(text: string, attachments: Parameters<typeof buildUserInput>[1] = []) {
    const done = turnDone();
    await session.send({ text, attachments: [] }, buildUserInput(text, attachments, null, null), options());
    await done;
  }

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "ditfa-e2e-"));
    workspace = join(root, "workspace");
    mkdirSync(workspace);
    spawnSync("git", ["init", "-q", "."], { cwd: workspace });
    writeFileSync(join(workspace, "keep.txt"), "old\n");

    server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => (body += chunk));
      request.on("end", () => {
        requests.push(body);
        const parsed = body ? (JSON.parse(body) as { input?: unknown }) : {};
        prompts.push(JSON.stringify(parsed.input ?? ""));
        const id = `resp_${requests.length}`;
        const events = [{ type: "response.created", response: { id } }, ...(script.shift() ?? say("Done.")), completed(id)];
        response.writeHead(200, { "content-type": "text/event-stream" });
        for (const event of events) {
          response.write(`event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`);
        }
        response.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;

    const home = join(root, "home");
    mkdirSync(home);
    writeFileSync(
      join(home, "config.toml"),
      `model_provider = "mock"
model = "gpt-5.5"
[model_providers.mock]
name = "Mock"
base_url = "http://127.0.0.1:${port}/v1"
wire_api = "responses"
`,
    );

    client = await AppServerClient.start({
      executable: binary as string,
      cwd: workspace,
      ditfaHome: home,
      env: { NO_PROXY: "*", no_proxy: "*" },
      clientVersion: "0.0.0",
      logger,
    });
    store = new TranscriptStore(join(root, "transcripts"), logger);
    session = new ThreadSession(client, logger, store);
    approvals = new ApprovalService(logger, (itemId) => {
      const entry = entries().find((candidate) => candidate.id === itemId);
      return entry?.kind === "fileChange" ? entry.changes : [];
    });
    client.setServerRequestHandler((request) => approvals.handle(request));
    client.onNotification((notification) => {
      session.handleNotification(notification);
      if (notification.method === "serverRequest/resolved") {
        approvals.serverResolved(notification.params.requestId);
      }
    });
    approvals.onChange((pending) => {
      for (const request of pending) {
        if (request.kind === "command" || request.kind === "fileChange") {
          approvals.resolve({ id: request.id, kind: request.kind, decision: "accept" });
        }
      }
    });
    await session.start(options().settings, workspace);
  }, 30_000);

  afterAll(async () => {
    client?.dispose();
    server?.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("gets an attached file in front of the model, and shows one user message", async () => {
    await run("what is in this file?", [{ kind: "file", path: "keep.txt", label: "keep.txt" }]);

    expect(prompts.at(-1)).toContain("- file: keep.txt");
    const users = entries().filter((entry) => entry.kind === "user");
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({ text: "what is in this file?" });
    expect(users[0]?.turnId).toBeTruthy();
    expect(session.snapshot().tokenUsage?.used).toBe(1050);
  }, 30_000);

  it("runs a command and shows it the way the user would have typed it", async () => {
    script.push(
      toolCall({
        type: "function_call",
        name: "exec_command",
        call_id: "cmd1",
        arguments: JSON.stringify({ cmd: "echo hello-e2e" }),
      }),
    );
    await run("run it");

    const command = entries().find((entry) => entry.kind === "command");
    expect(command).toMatchObject({ command: "echo hello-e2e", status: "completed", exitCode: 0 });
    expect((command as Extract<ChatEntry, { kind: "command" }>).output).toContain("hello-e2e");
  }, 30_000);

  it("applies an edit, reports it accurately, and can undo it without Git", async () => {
    script.push(
      toolCall({
        type: "custom_tool_call",
        name: "apply_patch",
        call_id: "patch1",
        input:
          "*** Begin Patch\n*** Add File: added.txt\n+one\n+two\n*** Update File: keep.txt\n@@\n-old\n+new\n*** End Patch\n",
      }),
    );
    await run("edit the files");

    expect(readFileSync(join(workspace, "keep.txt"), "utf8")).toBe("new\n");
    expect(existsSync(join(workspace, "added.txt"))).toBe(true);

    const change = entries().find((entry) => entry.kind === "fileChange");
    expect(change).toMatchObject({ status: "applied" });
    const summaries = (change as Extract<ChatEntry, { kind: "fileChange" }>).changes;
    expect(summaries.find((item) => item.kind === "add")).toMatchObject({ additions: 2, deletions: 0 });

    const turnId = session.latestTurnId as string;
    const plan = await planRevert(session.changesSince(turnId), workspace, async (path) =>
      existsSync(path) ? readFileSync(path, "utf8") : null,
    );
    expect(plan.skipped).toEqual([]);
    for (const step of plan.steps) {
      if (step.content === null) {
        rmSync(step.path);
      } else {
        writeFileSync(step.path, step.content);
      }
    }
    expect(readFileSync(join(workspace, "keep.txt"), "utf8")).toBe("old\n");
    expect(existsSync(join(workspace, "added.txt"))).toBe(false);

    await session.rollbackTo(turnId);
    expect(entries().some((entry) => entry.kind === "fileChange")).toBe(false);
  }, 30_000);

  it("keeps commands in the transcript after a resume, which the server alone would lose", async () => {
    const threadId = session.threadId as string;
    await new Promise((resolve) => setTimeout(resolve, 100));
    await session.resume(threadId, options().settings, workspace);

    expect(entries().some((entry) => entry.kind === "command")).toBe(true);
    expect(entries().filter((entry) => entry.kind === "user").length).toBeGreaterThanOrEqual(2);
  }, 30_000);

  it("notices an engine killed by a signal", async () => {
    const exited = new Promise<void>((resolve) => client.onExit(() => resolve()));
    const pid = (client as unknown as { child: { pid: number } }).child.pid;
    process.kill(pid, "SIGKILL");
    await exited;
    expect(client.isRunning).toBe(false);
  }, 15_000);
});
