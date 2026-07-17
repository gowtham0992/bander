export interface BackendResponse<T = unknown> {
  status: number;
  body: T;
}

export interface DemoBackend {
  readonly kind: "http" | "browser";
  request<T>(path: string, init?: RequestInit): Promise<BackendResponse<T>>;
}
