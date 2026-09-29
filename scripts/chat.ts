import { runCli } from "../src/cli.js";

runCli().catch((err) => {
  console.error("Error launching Sagentic CLI:", err);
  process.exit(1);
});
