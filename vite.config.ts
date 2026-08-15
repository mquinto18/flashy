import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    rollupOptions: {
      // Two entries: the app window and the floating auto-close warning panel, which
      // Tauri opens as a second webview (WebviewUrl::App("overlay.html")). The dev
      // server serves overlay.html automatically; this is what gets it into the
      // production build under dist/.
      // Paths are relative to Vite's root, so no __dirname is needed — which also
      // avoids the native config loader's unsupported-feature warning.
      input: {
        main: "index.html",
        overlay: "overlay.html",
      },
    },
  },
});
