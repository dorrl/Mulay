import react, { reactCompilerPreset } from '@vitejs/plugin-react'
import babel from '@rolldown/plugin-babel'
import { defineConfig } from 'vite'
export default defineConfig({
  plugins: [react(), babel({ presets: [reactCompilerPreset()] })],
  build: {
    outDir: 'dist/public',
    emptyOutDir: true,
    watch: {},
    minify: false,
    sourcemap: false,
    cssMinify: false,
    rollupOptions: {
      treeshake: false
    }
  }
})
