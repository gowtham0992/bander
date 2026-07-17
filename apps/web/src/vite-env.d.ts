/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_BANDER_BACKEND?: "http" | "browser";
}

declare module "*.css";
