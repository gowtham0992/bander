import type { BackendResponse, DemoBackend } from "./types.js";

export class HttpDemoBackend implements DemoBackend {
  readonly kind = "http" as const;

  async request<T>(path: string, init?: RequestInit): Promise<BackendResponse<T>> {
    const headers = new Headers(init?.headers);
    if (init?.body !== undefined) headers.set("content-type", "application/json");
    const response = await fetch(path, { ...init, headers });
    if (response.status === 204) return { status: 204, body: undefined as T };
    return { status: response.status, body: await response.json() as T };
  }
}
