import path from "node:path";

export interface HeroRuntimePaths {
  root: string;
  telegramState: string;
  pairingLink: string;
  runRoot: string;
  openclawConfig: string;
  openclawState: string;
  openclawHome: string;
  workspace: string;
  gatewayLog: string;
}

export function createHeroRuntimePaths(
  rootPath = ".bander/hero",
  runId = `${Date.now()}`,
): HeroRuntimePaths {
  const root = path.resolve(rootPath);
  const runRoot = path.join(root, "runs", runId);
  return {
    root,
    telegramState: path.join(root, "telegram-state.json"),
    pairingLink: path.join(root, "pairing-link.txt"),
    runRoot,
    openclawConfig: path.join(runRoot, "openclaw.json"),
    openclawState: path.join(runRoot, "openclaw-state"),
    openclawHome: path.join(runRoot, "openclaw-home"),
    workspace: path.join(runRoot, "workspace"),
    gatewayLog: path.join(runRoot, "openclaw-gateway.log"),
  };
}
