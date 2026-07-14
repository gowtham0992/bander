import { runLocal } from "./run-local.js";

console.log("Starting Bander at http://127.0.0.1:4312");
await runLocal("development");
