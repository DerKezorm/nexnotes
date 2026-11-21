import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Where the proxy points: the backend of a development run on 8570 (the port of the container). NEXNOTES_API changes it.
const apiTarget = process.env.NEXNOTES_API || 'http://127.0.0.1:8570'

/** The tab's icon with its checksum in the address. A browser keeps a tab icon per address and does not ask again,
 * so an icon that changed under the same address stayed old in the tab. */
function iconWithChecksum(): Plugin {
  return {
    name: 'icon-with-checksum',
    transformIndexHtml(html) {
      const sum = createHash('sha256').update(readFileSync(new URL('./public/logo.svg', import.meta.url))).digest('hex').slice(0, 12)
      return html.replace('href="/logo.svg"', `href="/logo.svg?v=${sum}"`)
    },
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss(), iconWithChecksum()],
  build: {
    rollupOptions: {
      output: {
        // Libraries change rarely. In their own file, they stay cached in the browser after an update.
        manualChunks(id) {
          if (id.includes('node_modules')) return 'vendor'
          return undefined
        },
      },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    css: false,
    // e2e/ is Playwright's (`npm run e2e`), not vitest's.
    exclude: ['node_modules/**', 'dist/**', 'e2e/**'],
  },
  server: {
    // Fixed port: if it is taken, Vite aborts instead of silently falling back to another one.
    port: 5570,
    strictPort: true,
    proxy: {
      // ws: notes are edited together live over the same address.
      '/api': { target: apiTarget, changeOrigin: false, ws: true },
    },
  },
  preview: {
    port: 5570,
    strictPort: true,
  },
})
