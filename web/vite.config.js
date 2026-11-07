import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  define: {
    __APP_DATE__: JSON.stringify(new Date().toISOString().slice(0, 10)),
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:4173',
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
