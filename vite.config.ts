import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: './',
  plugins: [react()],
  // 画面に出す更新日時（古いページを開いていないか確かめるため）
  define: { __BUILD_TIME__: JSON.stringify(new Date().toISOString()) },
  test: { globals: true },
});
