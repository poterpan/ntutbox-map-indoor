import { defineConfig } from 'vite';

// cdn.ntutbox.com only allows CORS from course.ntutbox.com and localhost:3000, so the dev page reaches
// it through these proxies. The course site itself passes its build-time catalog in as props instead.
export default defineConfig({
  server: {
    proxy: {
      // ntutbox-campus public data, same CORS situation as the course CDN.
      '/campus-data': {
        target: 'https://cdn.ntutbox.com/campus/v1',
        changeOrigin: true,
        rewrite: path => path.replace(/^\/campus-data/, ''),
      },
      '/course-data': {
        target: 'https://cdn.ntutbox.com/course/v1',
        changeOrigin: true,
        rewrite: path => path.replace(/^\/course-data/, ''),
      },
    },
  },
});
