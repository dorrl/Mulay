import react, { reactCompilerPreset } from '@vitejs/plugin-react'
import babel from '@rolldown/plugin-babel'
import { defineConfig } from 'vite'
export default defineConfig({
  plugins: [react(), babel({ presets: [reactCompilerPreset()] })],
  build: { outDir: 'dist/public', emptyOutDir: true },
  server: { 
    port: 33541,
    proxy: {
    '/server': { target: 'http://localhost:33541', changeOrigin: true, ws: true },
  } },
})
