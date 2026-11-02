/**
 * Fails the build when a bundle outgrows its budget.
 *
 * Panels that take seconds to boot or run out of memory get there one
 * dependency at a time, so the budget is enforced rather than remembered.
 */
import { statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DIST = resolve(dirname(fileURLToPath(import.meta.url)), "../dist");

const BUDGETS = {
  "extension.js": 200_000,
  "webview.js": 90_000,
  "webview.css": 40_000,
};

let failed = false;
for (const [file, limit] of Object.entries(BUDGETS)) {
  const size = statSync(resolve(DIST, file)).size;
  const over = size > limit;
  failed ||= over;
  console.log(`${over ? "FAIL" : "ok  "} ${file} ${size} / ${limit} bytes`);
}
process.exit(failed ? 1 : 0);
