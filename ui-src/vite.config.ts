import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: "/__openclaw__/video-assets/workbench/",
  build: {
    outDir: "../ui-dist-next",
    emptyOutDir: true,
    sourcemap: false,
  },
  server: {
    port: 5199,
    proxy: {
      "/__openclaw__/video-assets": {
        target: "http://127.0.0.1:33979",
        changeOrigin: false,
      },
    },
  },
});
