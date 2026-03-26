import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()]
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    resolve: {
      alias: {
        // 这里告诉 Vite：看到 '@renderer' 就去 src/renderer/src 找
        '@renderer': resolve('src/renderer/src'),
        // 🔥 关键修复：这里告诉 Vite：看到 '@' 也去 src/renderer/src 找
        '@': resolve('src/renderer/src')
      }
    },
    plugins: [react()]
  }
})