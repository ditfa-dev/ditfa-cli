import { chatMessages, prefersCompletionTokens, supportsFim, type CompletionRequest } from "./prompt";

/**
 * Talks to a model for Tab suggestions.
 *
 * This does not go through the agent engine: a suggestion has to come back in a
 * second, and a thread per keystroke would not. It speaks the OpenAI-style
 * protocol every provider Ditfa supports already offers, with the key the user
 * stored for it, and nothing leaves the machine except to that provider.
 */

export interface CompletionTarget {
  providerId: string;
  providerName: string;
  baseUrl: string;
  /** Absent for local servers. */
  apiKey?: string;
  model: string;
  /** True for a model server that supports the `suffix` field of `/completions`. */
  local: boolean;
}

export type FailureKind = "auth" | "model" | "rate" | "unreachable" | "unsupported" | "other";

export class CompletionError extends Error {
  constructor(
    readonly kind: FailureKind,
    message: string,
  ) {
    super(message);
    this.name = "CompletionError";
  }
}

export interface RequestOptions {
  maxTokens: number;
  signal: AbortSignal;
  /** Injected in tests. */
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
}

/** What a model turned out to accept, learned from its refusals and remembered. */
const learned = new Map<string, { completionTokens?: boolean; noFim?: boolean; noTemperature?: boolean }>();

function memoKey(target: CompletionTarget): string {
  return `${target.baseUrl}|${target.model}`;
}

export function forgetLearned(): void {
  learned.clear();
}

/** Fetches one suggestion's raw text. The caller cleans it up. */
export async function requestCompletion(
  target: CompletionTarget,
  request: CompletionRequest,
  options: RequestOptions,
): Promise<string> {
  const memo = learned.get(memoKey(target)) ?? {};
  if (target.local && supportsFim(target.model) && !memo.noFim) {
    try {
      return await fillInMiddle(target, request, options);
    } catch (error) {
      if (!(error instanceof CompletionError) || error.kind !== "unsupported") {
        throw error;
      }
      learned.set(memoKey(target), { ...memo, noFim: true });
    }
  }
  return chat(target, request, options);
}

async function fillInMiddle(
  target: CompletionTarget,
  request: CompletionRequest,
  options: RequestOptions,
): Promise<string> {
  const body = await post(
    target,
    "/completions",
    {
      model: target.model,
      prompt: request.prefix,
      suffix: request.suffix,
      max_tokens: options.maxTokens,
      temperature: 0.1,
      stream: false,
    },
    options,
  );
  const text = (body as { choices?: { text?: unknown }[] }).choices?.[0]?.text;
  return typeof text === "string" ? text : "";
}

async function chat(target: CompletionTarget, request: CompletionRequest, options: RequestOptions): Promise<string> {
  const key = memoKey(target);
  let memo = learned.get(key) ?? {};
  if (prefersCompletionTokens(target.model)) {
    memo = { completionTokens: true, noTemperature: true, ...memo };
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const body: Record<string, unknown> = {
      model: target.model,
      messages: chatMessages(request),
      stream: false,
    };
    body[memo.completionTokens ? "max_completion_tokens" : "max_tokens"] = options.maxTokens;
    if (!memo.noTemperature) {
      body.temperature = 0.1;
    }

    try {
      const response = await post(target, "/chat/completions", body, options);
      return readChat(response);
    } catch (error) {
      // Newer models rename the token limit and refuse a temperature: learn it once.
      if (error instanceof CompletionError && error.kind === "unsupported") {
        const message = error.message.toLowerCase();
        const next = { ...memo };
        if (message.includes("max_tokens") && !memo.completionTokens) {
          next.completionTokens = true;
        } else if (message.includes("temperature") && !memo.noTemperature) {
          next.noTemperature = true;
        }
        if (next.completionTokens !== memo.completionTokens || next.noTemperature !== memo.noTemperature) {
          memo = next;
          learned.set(key, memo);
          continue;
        }
      }
      throw error;
    }
  }
  throw new CompletionError("other", "The provider kept rejecting the request.");
}

function readChat(body: unknown): string {
  const message = (body as { choices?: { message?: { content?: unknown }; text?: unknown }[] }).choices?.[0];
  const content = message?.message?.content ?? message?.text;
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === "string" ? part : typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : ""))
      .join("");
  }
  return "";
}

async function post(
  target: CompletionTarget,
  path: string,
  body: Record<string, unknown>,
  options: RequestOptions,
): Promise<unknown> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (target.apiKey) {
    headers.Authorization = `Bearer ${target.apiKey}`;
    if (target.providerId === "anthropic") {
      headers["x-api-key"] = target.apiKey;
      headers["anthropic-version"] = "2023-06-01";
    }
  }

  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(`${target.baseUrl.replace(/\/$/, "")}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: options.signal,
    });
  } catch (error) {
    if (options.signal.aborted) {
      throw error;
    }
    throw new CompletionError(
      "unreachable",
      target.local
        ? `${target.providerName} is not answering on ${target.baseUrl}.`
        : `Could not reach ${target.providerName}.`,
    );
  }

  if (response.ok) {
    return response.json();
  }
  const detail = await readError(response);
  if (response.status === 401 || response.status === 403) {
    throw new CompletionError("auth", `${target.providerName} rejected the API key.`);
  }
  if (response.status === 429) {
    throw new CompletionError("rate", `${target.providerName} is rate limiting requests.`);
  }
  if (response.status === 404 && /model/i.test(detail)) {
    throw new CompletionError("model", `${target.providerName} has no model called ${target.model}.`);
  }
  if (response.status === 400 || response.status === 404 || response.status === 405 || response.status === 501) {
    throw new CompletionError("unsupported", detail || `HTTP ${response.status}`);
  }
  throw new CompletionError("other", `${target.providerName} answered HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
}

async function readError(response: Response): Promise<string> {
  try {
    const text = await response.text();
    try {
      const parsed = JSON.parse(text) as { error?: { message?: unknown } | string; message?: unknown };
      const message =
        typeof parsed.error === "string"
          ? parsed.error
          : typeof parsed.error?.message === "string"
            ? parsed.error.message
            : parsed.message;
      return typeof message === "string" ? message.slice(0, 300) : text.slice(0, 300);
    } catch {
      return text.slice(0, 300);
    }
  } catch {
    return "";
  }
}
