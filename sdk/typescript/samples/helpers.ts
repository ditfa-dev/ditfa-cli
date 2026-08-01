import path from "node:path";

export function ditfaPathOverride() {
  return (
    process.env.DITFA_EXECUTABLE ??
    path.join(process.cwd(), "..", "..", "ditfa-rs", "target", "debug", "ditfa")
  );
}
