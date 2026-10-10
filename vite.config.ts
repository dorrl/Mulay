import react, { reactCompilerPreset } from '@vitejs/plugin-react'
import babel from '@rolldown/plugin-babel'
import { defineConfig } from 'vite'
export default defineConfig({
  plugins: [react(), babel({ presets: [reactCompilerPreset()] })],
  build: { outDir: 'dist/public', emptyOutDir: true },
  server: { proxy: {
    '/api': { target: 'http://localhost:3001', changeOrigin: true },
    '/auth': { target: 'http://localhost:3001', changeOrigin: true },
    '/socket.io': { target: 'http://localhost:3001', ws: true },
  } },
})
