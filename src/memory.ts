import type { Command } from "commander";
import { CodeMemory } from "./memory-index.js";
import { serveCodeMemory } from "./memory-mcp.js";
export function registerMemoryCommands(program: Command) {
  const memory = program
    .command("memory")
    .description("Private local code index and bounded-context MCP tools");
  for (const action of ["index", "status", "architecture"] as const) {
    memory
      .command(action)
      .option("--repo <directory>", "Approved project directory", process.cwd())
      .action((options) => {
        const store = new CodeMemory(options.repo);
        try {
          console.log(
            JSON.stringify(
              action === "index"
                ? store.refresh()
                : action === "status"
                  ? store.status()
                  : store.architecture(),
              null,
              2,
            ),
          );
        } finally {
          store.close();
        }
      });
  }
  memory
    .command("search <query>")
    .option("--repo <directory>", "Approved project directory", process.cwd())
    .option("--limit <count>", "Maximum results, 1–20", "8")
    .action((query, options) => {
      const store = new CodeMemory(options.repo);
      try {
        console.log(
          JSON.stringify(store.search(query, Number(options.limit)), null, 2),
        );
      } finally {
        store.close();
      }
    });
  memory
    .command("serve")
    .description("Serve MCP over stdio for one approved repository")
    .option("--repo <directory>", "Approved project directory", process.cwd())
    .action(async (options) => {
      const store = new CodeMemory(options.repo);
      try {
        await serveCodeMemory(store);
      } finally {
        store.close();
      }
    });
}
