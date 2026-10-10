import { defineConfig } from 'vite';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { resolve, join, normalize } from 'node:path';

// CAMPUS_DATA=cache serves /campus-data from .cache/campus-v1 (npm run snapshot:campus) instead of the CDN proxy,
// so visual-regression runs are offline and pinned to one data revision.
const useCache = process.env.CAMPUS_DATA === 'cache';
const CACHE_DIR = resolve('.cache/campus-v1');
const cachePlugin = {
  name: 'campus-data-cache',
  configureServer(server) {
    server.middlewares.use('/campus-data', (req, res, next) => {
      const file = normalize(join(CACHE_DIR, decodeURIComponent(req.url.split('?')[0])));
      if (!file.startsWith(CACHE_DIR) || !existsSync(file) || !statSync(file).isFile()) { res.statusCode = 404; return res.end('not in cache'); }
      res.setHeader('Content-Type', 'application/json');
      createReadStream(file).pipe(res);
    });
  },
};


// cdn.ntutbox.com only allows CORS from course.ntutbox.com and localhost:3000, so the dev page reaches
// it through these proxies. The course site itself passes its build-time catalog in as props instead.
export default defineConfig({
  plugins: useCache ? [cachePlugin] : [],
  server: {
    port: 3000,
    strictPort: true,
    proxy: {
      // ntutbox-campus public data, same CORS situation as the course CDN.
      ...(useCache ? {} : { '/campus-data': {
        target: 'https://cdn.ntutbox.com/campus/v1',
        changeOrigin: true,
        rewrite: path => path.replace(/^\/campus-data/, ''),
      } }),
      // Campus 3D models are private: a token comes from the course site (MODELS_TOKEN_ORIGIN, default
      // its production host), and models.ntutbox.com accepts the dev page's own origin localhost:3000.
      // The course endpoint only serves same-origin page fetches, so the proxy drops the dev Origin.
      '/api/model-token': {
        target: process.env.MODELS_TOKEN_ORIGIN || 'https://course.ntutbox.com',
        changeOrigin: true,
        configure: proxy => proxy.on('proxyReq', req => req.removeHeader('origin')),
      },
      '/course-data': {
        target: 'https://cdn.ntutbox.com/course/v1',
        changeOrigin: true,
        rewrite: path => path.replace(/^\/course-data/, ''),
      },
    },
  },
});
