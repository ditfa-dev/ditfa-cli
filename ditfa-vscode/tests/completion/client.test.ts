import { beforeEach, describe, expect, it, vi } from "vitest";

import { CompletionError, forgetLearned, requestCompletion, type CompletionTarget } from "../../src/completion/client";

const request = { prefix: "const a = ", suffix: ";", language: "typescript", path: "a.ts", neighbors: [] };
const signal = new AbortController().signal;

const hosted: CompletionTarget = {
  providerId: "openai",
  providerName: "OpenAI",
  baseUrl: "https://api.example.com/v1",
  apiKey: "sk-test",
  model: "small-model",
  local: false,
};
const local: CompletionTarget = {
  providerId: "ollama",
  providerName: "Ollama",
  baseUrl: "http://localhost:11434/v1",
  model: "qwen2.5-coder:1.5b",
  local: true,
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const chatReply = (content: string) => json({ choices: [{ message: { content } }] });

describe("requestCompletion", () => {
  beforeEach(() => forgetLearned());

  it("asks a hosted provider through chat completions, with the key", async () => {
    const fetchImpl = vi.fn(async () => chatReply("1 + 2"));
    const text = await requestCompletion(hosted, request, { maxTokens: 64, signal, fetchImpl });

    expect(text).toBe("1 + 2");
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.example.com/v1/chat/completions");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer sk-test");
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({ model: "small-model", max_tokens: 64, stream: false });
    expect(JSON.stringify(body.messages)).toContain("<CURSOR>");
  });

  it("uses fill-in-the-middle on a local code model", async () => {
    const fetchImpl = vi.fn(async () => json({ choices: [{ text: "1 + 2" }] }));
    const text = await requestCompletion(local, request, { maxTokens: 64, signal, fetchImpl });

    expect(text).toBe("1 + 2");
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://localhost:11434/v1/completions");
    expect(JSON.parse(init.body as string)).toMatchObject({ prompt: "const a = ", suffix: ";" });
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it("falls back to chat once fill-in-the-middle is refused, and remembers", async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      url.endsWith("/completions") && !url.includes("chat")
        ? json({ error: { message: "does not support insert" } }, 400)
        : chatReply("x"),
    );
    expect(await requestCompletion(local, request, { maxTokens: 64, signal, fetchImpl })).toBe("x");
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    await requestCompletion(local, request, { maxTokens: 64, signal, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("learns that a model wants the other token-limit name", async () => {
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      return "max_tokens" in body
        ? json({ error: { message: "Unsupported parameter: 'max_tokens'. Use 'max_completion_tokens'." } }, 400)
        : chatReply("ok");
    });
    expect(await requestCompletion(hosted, request, { maxTokens: 64, signal, fetchImpl })).toBe("ok");
    const last = JSON.parse((fetchImpl.mock.calls.at(-1) as unknown as [string, RequestInit])[1].body as string);
    expect(last.max_completion_tokens).toBe(64);
    expect(last.max_tokens).toBeUndefined();
  });

  it("sends the right token field straight away for reasoning-era models", async () => {
    const fetchImpl = vi.fn(async () => chatReply("ok"));
    await requestCompletion({ ...hosted, model: "gpt-5-mini" }, request, { maxTokens: 64, signal, fetchImpl });
    const body = JSON.parse((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.max_completion_tokens).toBe(64);
    expect(body.temperature).toBeUndefined();
  });

  it("reads content that arrives as parts", async () => {
    const fetchImpl = vi.fn(async () =>
      json({ choices: [{ message: { content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] } }] }),
    );
    expect(await requestCompletion(hosted, request, { maxTokens: 64, signal, fetchImpl })).toBe("ab");
  });

  it.each([
    [401, "auth"],
    [429, "rate"],
    [500, "other"],
  ])("turns HTTP %i into a %s failure", async (status, kind) => {
    const fetchImpl = vi.fn(async () => json({ error: { message: "nope" } }, status));
    await expect(requestCompletion(hosted, request, { maxTokens: 64, signal, fetchImpl })).rejects.toMatchObject({
      kind,
    });
  });

  it("names a missing model", async () => {
    const fetchImpl = vi.fn(async () => json({ error: { message: "The model does not exist" } }, 404));
    await expect(requestCompletion(hosted, request, { maxTokens: 64, signal, fetchImpl })).rejects.toMatchObject({
      kind: "model",
    });
  });

  it("reports an unreachable server in plain words", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const error = await requestCompletion(local, request, { maxTokens: 64, signal, fetchImpl }).catch((e) => e);
    expect(error).toBeInstanceOf(CompletionError);
    expect(error.kind).toBe("unreachable");
    expect(error.message).toContain("not answering");
  });

  it("lets an abort through untouched", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchImpl = vi.fn(async () => {
      throw new DOMException("aborted", "AbortError");
    });
    await expect(
      requestCompletion(hosted, request, { maxTokens: 64, signal: controller.signal, fetchImpl }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});
