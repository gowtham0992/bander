import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  publicDir: "../../production",
  server: {
    strictPort: true,
    proxy: {
      "/api": "http://127.0.0.1:4310",
    },
  },
  build: {
    target: "es2022",
    sourcemap: true,
  },
});
