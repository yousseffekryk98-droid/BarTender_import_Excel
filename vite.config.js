import { defineConfig } from 'vite';

// Production builds get a strict CSP (no network at all); the dev server additionally needs ws: for HMR.
function cspPlugin() {
  return {
    name: 'els-csp',
    transformIndexHtml(html, ctx) {
      const dev = Boolean(ctx.server);
      const csp = [
        "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob:",
        "font-src 'self' data:", "connect-src 'self'" + (dev ? ' ws: http://127.0.0.1:5173' : ''), "object-src 'none'",
        "base-uri 'none'", "frame-src 'self'", "form-action 'none'", "worker-src 'self' blob:"
      ].join('; ');
      return html.replace('%CSP%', csp);
    }
  };
}

export default defineConfig({
  base: './',
  plugins: [cspPlugin()],
  // Native JSX transform (no inline React Refresh scripts) keeps the strict CSP working.
  esbuild: { jsx: 'transform', jsxFactory: 'React.createElement', jsxFragment: 'React.Fragment' },
  build: {
    outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 3000, target: 'chrome120',
    rollupOptions: { output: { manualChunks: { exceljs: ['exceljs'], barcode: ['bwip-js'] } } }
  },
  server: { host: '127.0.0.1', port: 5173, strictPort: true }
});
