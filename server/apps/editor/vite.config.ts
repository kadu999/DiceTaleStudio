import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

/**
 * 编辑器构建配置。
 *
 * 开发期：Vite 直接跑编辑器，`/api` 与 `/client`、`/editor` 反代到后端
 * （后端默认 1420，可用 DTS_BACKEND 覆盖）。
 */
const backendTarget = process.env.DTS_BACKEND ?? "http://127.0.0.1:1420";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // 监听所有网卡：手机 / 平板可用本机局域网 IP 直接打开开发服务器
    // （http://<本机IP>:5173），后端与 WebSocket 由下面的代理转发。
    host: true,
    port: 5173,
    strictPort: false,
    proxy: {
      "/api": { target: backendTarget, changeOrigin: true },
      "/editor": { target: backendTarget, ws: true, changeOrigin: true },
      "/client": { target: backendTarget, ws: true, changeOrigin: true },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
});
