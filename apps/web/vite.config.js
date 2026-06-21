import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
    plugins: [react()],
    build: { outDir: 'dist' },
    server: {
        host: '127.0.0.1',
        port: 1430,
        proxy: {
            '/api': 'http://127.0.0.1:8787',
            '/realtime': { target: 'ws://127.0.0.1:8787', ws: true }
        }
    }
});
