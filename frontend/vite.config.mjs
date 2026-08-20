import { defineConfig } from "vite";

export default defineConfig({
  server: {
    host: "127.0.0.1",
    allowedHosts: [".trycloudflare.com", ".ngrok-free.dev"],
    proxy: {
      "/api": {
        target: "http://127.0.0.1:4000",
        changeOrigin: true,
      },
    },
  },
});
