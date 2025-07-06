import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 3001,
    host: true, // enable external access
    allowedHosts: ["conference.mmup.org","4f59-45-93-169-195.ngrok-free.app"], // explicitly allow your domain
  },
});
