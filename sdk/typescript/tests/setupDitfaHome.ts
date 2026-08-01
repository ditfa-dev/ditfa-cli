import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach } from "@jest/globals";

const originalDitfaHome = process.env.DITFA_HOME;
let currentDitfaHome: string | undefined;

beforeEach(async () => {
  currentDitfaHome = await fs.mkdtemp(path.join(os.tmpdir(), "ditfa-sdk-test-"));
  process.env.DITFA_HOME = currentDitfaHome;
});

afterEach(async () => {
  const ditfaHomeToDelete = currentDitfaHome;
  currentDitfaHome = undefined;

  if (originalDitfaHome === undefined) {
    delete process.env.DITFA_HOME;
  } else {
    process.env.DITFA_HOME = originalDitfaHome;
  }

  if (ditfaHomeToDelete) {
    await fs.rm(ditfaHomeToDelete, { recursive: true, force: true });
  }
});
