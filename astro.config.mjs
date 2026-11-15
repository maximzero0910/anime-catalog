import { defineConfig } from 'astro/config';
import node from '@astrojs/node';

export default defineConfig({
  output: 'static',
  adapter: node({ mode: 'standalone' }),
  vite: {
    server: {
      proxy: {
        '/api/anime': { target: 'http://127.0.0.1:8787', changeOrigin: true },
      },
    },
  },
});
