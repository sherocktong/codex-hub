import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Redirect the default home directory so that any code/path that falls back to
// ~/.codex (when CODEX_DIR is not explicitly set) touches a temporary directory
// instead of the user's real home directory during tests.
const tmpHome = path.join(os.tmpdir(), `codx-hub-test-home-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, ".codex"), { recursive: true });
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;
