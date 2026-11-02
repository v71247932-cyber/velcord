import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // iPhones on iOS 15 and 16.0-16.3 do not know the newer CSS (e.g. `(width<=768px)` media queries, which the
  // build would otherwise write): the phone layout was never applied there and the chat did not open.
  build: { cssTarget: 'safari14', target: ['safari14', 'chrome90', 'firefox90'] },
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:8787',
        changeOrigin: true,
      },
    },
  },
})
