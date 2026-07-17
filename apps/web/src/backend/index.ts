import { BrowserDemoBackend } from "./browser.js";
import { HttpDemoBackend } from "./http.js";
import type { DemoBackend } from "./types.js";

export type { BackendResponse, DemoBackend } from "./types.js";

export function createDemoBackend(): DemoBackend {
  return import.meta.env.VITE_BANDER_BACKEND === "browser"
    ? new BrowserDemoBackend()
    : new HttpDemoBackend();
}
