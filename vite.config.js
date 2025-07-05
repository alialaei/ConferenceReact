import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 3001,
    host: true, // enable external access
    allowedHosts: ["conference.mmup.org"], // explicitly allow your domain
  },
});
