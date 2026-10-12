import react, { reactCompilerPreset } from '@vitejs/plugin-react'
import babel from '@rolldown/plugin-babel'
import { defineConfig } from 'vite'
export default defineConfig({
  plugins: [react(), babel({ presets: [reactCompilerPreset()] })],
  build: { 
    outDir: 'dist/public', 
    emptyOutDir: true,

    watch: {},
    minify: false,      // ⚡ 압축을 끄면 빌드 속도가 압도적으로 빨라집니다.
    sourcemap: false,   // 소스맵 생성을 꺼서 연산 줄이기
    cssMinify: false,   // CSS 압축도 해제
    rollupOptions: {
      // 트리쉐이킹 등 무거운 연산을 최소화하여 Watch 속도 극대화
      treeshake: false 
    }
  },
  server: { 
    port: 33541,
    proxy: {
    '/server': { target: 'http://localhost:33541', changeOrigin: true, ws: true },
  } },
})
