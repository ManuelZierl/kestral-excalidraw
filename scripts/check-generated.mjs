import { execFileSync } from "node:child_process";

const paths = ["dist", "THIRD-PARTY-NOTICES.txt"];
const status = execFileSync("git", ["status", "--porcelain", "--", ...paths], { encoding: "utf8" });
if (status.trim()) {
  process.stderr.write(status);
  throw new Error("generated package output differs from the committed files");
}
