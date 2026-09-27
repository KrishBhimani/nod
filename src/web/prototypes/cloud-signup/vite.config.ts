import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  publicDir: fileURLToPath(new URL('../../../../public', import.meta.url)),
  plugins: [react()],
  server: { host: '127.0.0.1', port: 4318, strictPort: true },
  build: {
    outDir: fileURLToPath(new URL('../../../../dist/prototype-cloud', import.meta.url)),
    emptyOutDir: true,
  },
});
