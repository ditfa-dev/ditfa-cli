import { describe, expect, it } from "vitest";

import {
  allowsMultiline,
  chatMessages,
  cleanCompletion,
  isSensitivePath,
  prefersCompletionTokens,
  supportsFim,
  takeWindow,
  worthSuggesting,
} from "../../src/completion/prompt";

const clean = (raw: string, prefix = "", suffix = "", multiline = true, maxLines = 14) =>
  cleanCompletion(raw, { prefix, suffix, multiline, maxLines });

describe("takeWindow", () => {
  it("starts on a line boundary when it has to cut", () => {
    const text = "alpha\nbeta\ngamma\ndelta";
    const { prefix } = takeWindow(text, text.length, 12, 0);
    expect(prefix).toBe("gamma\ndelta");
  });

  it("ends on a line boundary after the cursor", () => {
    const text = "one\ntwo\nthree\nfour";
    const { suffix } = takeWindow(text, 3, 0, 10);
    expect(suffix).toBe("\ntwo");
  });

  it("keeps everything when the file is small", () => {
    expect(takeWindow("abc", 1, 100, 100)).toEqual({ prefix: "a", suffix: "bc" });
  });
});

describe("allowsMultiline", () => {
  it("allows it at the end of a line and before closing punctuation", () => {
    expect(allowsMultiline("")).toBe(true);
    expect(allowsMultiline(")")).toBe(true);
    expect(allowsMultiline(" });")).toBe(true);
  });

  it("keeps a suggestion to one line when code follows the cursor", () => {
    expect(allowsMultiline(" + other")).toBe(false);
    expect(allowsMultiline(".map(x)")).toBe(false);
  });
});

describe("worthSuggesting", () => {
  it("waits until a word has started", () => {
    expect(worthSuggesting("", "const a = 1;")).toBe(false);
    expect(worthSuggesting("c", "const a = 1;")).toBe(false);
    expect(worthSuggesting("co", "")).toBe(true);
  });

  it("offers a body on the line after an opening brace or arrow", () => {
    expect(worthSuggesting("  ", "function f() {")).toBe(true);
    expect(worthSuggesting("  ", "const f = () =>")).toBe(true);
    expect(worthSuggesting("  ", "if (x):")).toBe(true);
  });
});

describe("cleanCompletion", () => {
  it("returns plain code untouched", () => {
    expect(clean("return a + b;")).toBe("return a + b;");
  });

  it("unwraps a fenced answer", () => {
    expect(clean("```ts\nreturn a + b;\n```")).toBe("return a + b;");
  });

  it("drops fill-in-the-middle tokens a model leaks", () => {
    expect(clean("foo()<|fim_middle|>")).toBe("foo()");
  });

  it("does not repeat the line the cursor is on", () => {
    expect(clean("const total = items.length;", "  const total = ")).toBe("items.length;");
  });

  it("stops where the code after the cursor takes over", () => {
    expect(clean("a, b)", "call(", ")")).toBe("a, b");
  });

  it("keeps to the current line when asked", () => {
    expect(clean("first();\nsecond();", "", "", false)).toBe("first();");
  });

  it("caps the number of lines", () => {
    const many = Array.from({ length: 30 }, (_, index) => `line ${index}`).join("\n");
    expect(clean(many, "", "", true, 5)?.split("\n")).toHaveLength(5);
  });

  it("says nothing when there is nothing to say", () => {
    expect(clean("   \n  ")).toBeNull();
    expect(clean("")).toBeNull();
  });

  it("does not suggest what already follows the cursor", () => {
    expect(clean("return x;", "", "return x;\n}")).toBeNull();
  });
});

describe("model families", () => {
  it("recognizes fill-in-the-middle code models", () => {
    expect(supportsFim("qwen2.5-coder:1.5b")).toBe(true);
    expect(supportsFim("deepseek-coder-v2")).toBe(true);
    expect(supportsFim("llama3.1:8b")).toBe(false);
  });

  it("knows which models rename the token limit", () => {
    expect(prefersCompletionTokens("o3-mini")).toBe(true);
    expect(prefersCompletionTokens("gpt-5-mini")).toBe(true);
    expect(prefersCompletionTokens("gpt-4o-mini")).toBe(false);
  });
});

describe("chatMessages", () => {
  it("marks the cursor and names the file", () => {
    const [system, user] = chatMessages({
      prefix: "const a = ",
      suffix: ";",
      language: "typescript",
      path: "src/a.ts",
      neighbors: [{ path: "src/b.ts", text: "export const b = 1;" }],
    });
    expect(system?.role).toBe("system");
    expect(user?.content).toContain("const a = <CURSOR>;");
    expect(user?.content).toContain("src/a.ts (typescript)");
    expect(user?.content).toContain("Related file src/b.ts");
  });
});

describe("isSensitivePath", () => {
  it.each([
    "/w/.env",
    "/w/.env.production",
    "/w/config/secrets.json",
    "/home/u/.ssh/id_ed25519",
    "C:\\w\\server.pem",
    "/w/.npmrc",
  ])("treats %s as a secret", (path) => {
    expect(isSensitivePath(path)).toBe(true);
  });

  it.each(["/w/src/env.ts", "/w/src/keys.ts", "/w/README.md", "/w/environment.yml"])("leaves %s alone", (path) => {
    expect(isSensitivePath(path)).toBe(false);
  });
});
