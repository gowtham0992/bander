import { spawnSync } from "node:child_process";
import path from "node:path";

const cwd = process.cwd();
const vite = path.join(cwd, "node_modules", ".bin", "vite");
const environment: NodeJS.ProcessEnv = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  NODE_ENV: "production",
  BANDER_PAGES_BUILD: "1",
  VITE_BANDER_BACKEND: "browser",
};

const result = spawnSync(vite, ["build"], {
  cwd: path.join(cwd, "apps", "web"),
  env: environment,
  encoding: "utf8",
  shell: false,
  stdio: "inherit",
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
