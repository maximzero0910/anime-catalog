import { defineConfig } from 'astro/config';
import node from '@astrojs/node';

export default defineConfig({
  site: 'https://anineko.eu',
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
