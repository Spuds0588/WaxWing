import { defineConfig } from "vite";

// Vanilla ES-module app (no framework, no build step in authoring).
// Vite is used purely as a dev server / static bundler so the same
// source can be served locally and shipped as static files.
export default defineConfig({
  // Relative base so the built site works on GitHub Pages subpaths too.
  base: "./",
  server: {
    host: "0.0.0.0",
    port: Number(process.env.PORT) || 5173,
    strictPort: false,
    hmr: false,
  },
  build: {
    outDir: "dist",
    target: "es2022",
  },
});
