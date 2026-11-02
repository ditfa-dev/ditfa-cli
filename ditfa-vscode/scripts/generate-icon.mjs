/**
 * Copy the canonical Ditfa desktop icon into the Marketplace package unchanged.
 * Source artwork: ditfa-dev/ditfa, apps/desktop/src-tauri/icons/icon.png.
 * Keep media/ditfa.png synchronized with that asset when the brand changes.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const source = new URL("../media/ditfa.png", import.meta.url);
const target = new URL("../media/icon.png", import.meta.url);
const png = readFileSync(source);
const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
if (png.length < 24 || !png.subarray(0, 8).equals(signature)) {
  throw new Error("The canonical Ditfa icon must be a PNG.");
}
const width = png.readUInt32BE(16);
const height = png.readUInt32BE(20);
if (width !== height || width < 128) {
  throw new Error("The Ditfa icon must be square and at least 128 pixels wide.");
}
writeFileSync(target, png);
console.log(`[generate-icon] copied ${width}x${height} desktop artwork to ${fileURLToPath(target)}`);
