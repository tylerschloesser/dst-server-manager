// docs/web.md §6: the dev server proxies /api to the local API on port 8787. `changeOrigin:
// false` matters — the API's CSRF check compares `Origin` with `PUBLIC_ORIGIN`
// (http://localhost:5173 locally), so the proxy must not rewrite it (docs/auth.md §0).
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: '/',
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:8787', changeOrigin: false },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
});
