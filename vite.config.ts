import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: "src/ui",
  plugins: [react()],
  build: {
    outDir: "../../dist/ui",
    emptyOutDir: false,
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      output: {
        manualChunks: {
          graph: ["@xyflow/react"],
          layout: ["elkjs/lib/elk.bundled.js"],
          icons: ["@phosphor-icons/react"],
        },
      },
    },
  },
  server: {
    proxy: {
      "/api": "http://127.0.0.1:43117",
    },
  },
});
