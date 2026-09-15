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
  // relative asset URLs resolve against <base href>, which the server sets to the URL base
  base: './',
  build: { outDir: 'dist', emptyOutDir: true },
});
