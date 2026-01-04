import { build, context } from "esbuild";
import { rmSync } from "node:fs";

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

rmSync("dist", { recursive: true, force: true });

/**
 * The extension host runs in Node and must not bundle the `vscode` module —
 * VS Code injects it at runtime.
 */
const extensionConfig = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "dist/extension.js",
  platform: "node",
  target: "node20",
  format: "cjs",
  external: ["vscode"],
  sourcemap: production ? false : "inline",
  minify: production,
  logLevel: "info",
  define: { "process.env.NODE_ENV": JSON.stringify(production ? "production" : "development") },
};

/**
 * The webview runs in a browser context with no Node APIs and a strict CSP,
 * so everything it needs must be inlined into a single IIFE bundle.
 */
const webviewConfig = {
  entryPoints: ["webview/main.ts"],
  bundle: true,
  outfile: "dist/webview.js",
  platform: "browser",
  target: "es2022",
  format: "iife",
  sourcemap: production ? false : "inline",
  minify: production,
  logLevel: "info",
};

const styleConfig = {
  entryPoints: ["webview/styles.css"],
  bundle: true,
  outfile: "dist/webview.css",
  minify: production,
  logLevel: "info",
};

const configs = [extensionConfig, webviewConfig, styleConfig];

if (watch) {
  const contexts = await Promise.all(configs.map((config) => context(config)));
  await Promise.all(contexts.map((ctx) => ctx.watch()));
  console.log("[esbuild] watching…");
} else {
  await Promise.all(configs.map((config) => build(config)));
  console.log(`[esbuild] built (${production ? "production" : "development"})`);
}
