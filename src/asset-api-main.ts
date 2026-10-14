// Starts the local asset API without opening an MCP stdio transport. The main
// module still owns configuration loading and all lifecycle handling.
process.env.FLOW_TRANSPORT = "http";
process.env.FLOW_ENV_FILE = ".env.asset-studio";
await import("./index.js");
