import { assertSafeBuildEnvironment } from './src/lib/clientKey';
import { defineConfig, type ResolvedConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// https://vitejs.dev/config/
export default defineConfig(() => ({
  base: "./",
  optimizeDeps: { entries: ['index.html'] },
  server: {
    host: "::",
    port: 8080,
    watch: { ignored: ['**/src-tauri/target/**', '**/.local-backups/**', '**/delivery/**', '**/dashboard-candidate/**'] },
    hmr: {
      overlay: false,
    },
  },
  plugins: [{ name: "pos-client-credential-guard", configResolved(config: ResolvedConfig) { assertSafeBuildEnvironment(config.env); } }, react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
}));
