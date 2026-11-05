import { defineConfig } from 'vite'
import base from './vite.config.ts'

// Disposable static demo. Never proxy /api to a real service from the prototype.
export default defineConfig({
  ...base,
  server: { host: '127.0.0.1', port: 5174, strictPort: true, proxy: {} },
  preview: { host: '127.0.0.1', port: 5174, strictPort: true, proxy: {} },
})
