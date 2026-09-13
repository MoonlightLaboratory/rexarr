import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@shared': path.resolve(__dirname, '../shared') },
  },
  server: {
    port: 7979,
    fs: { allow: ['..'] },
    proxy: {
      '/api': { target: 'http://localhost:7878', changeOrigin: true },
    },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
