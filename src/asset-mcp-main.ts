import path from "path";
import { fileURLToPath } from "url";

// Codex launches this process for the MCP stdio transport. It intentionally
// does not bind the local HTTP port: the optional Asset API can keep running
// in a separate process without causing Codex tool discovery to fail.
const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
process.chdir(path.dirname(moduleDirectory));
process.env.FLOW_TRANSPORT = "stdio";
process.env.FLOW_ENV_FILE = ".env.asset-studio";

await import("./index.js");
