import path from "path";
import { fileURLToPath } from "url";

// Codex may launch an MCP command from another workspace. Resolve this
// project's private configuration relative to this launcher, then expose both
// the stdio MCP transport and the loopback-only asset API from one engine.
const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
process.chdir(path.dirname(moduleDirectory));
process.env.FLOW_TRANSPORT = "both";
process.env.FLOW_ENV_FILE = ".env.asset-studio";

await import("./index.js");
