import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@co/shared': fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url)) },
  },
  server: {
    proxy: { '/api': 'http://localhost:8080', '/pay': 'http://localhost:8080', '/paid': 'http://localhost:8080' },
  },
});
