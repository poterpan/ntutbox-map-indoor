import { defineConfig } from 'vite';

// cdn.ntutbox.com only allows CORS from course.ntutbox.com and localhost:3000, so the dev page reaches
// it through these proxies. The course site itself passes its build-time catalog in as props instead.
export default defineConfig({
  server: {
    port: 3000,
    strictPort: true,
    proxy: {
      // ntutbox-campus public data, same CORS situation as the course CDN.
      '/campus-data': {
        target: 'https://cdn.ntutbox.com/campus/v1',
        changeOrigin: true,
        rewrite: path => path.replace(/^\/campus-data/, ''),
      },
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
