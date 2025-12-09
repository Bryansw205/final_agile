import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: '0.0.0.0', // Escuchar en todas las interfaces (IPv4 e IPv6)
    strictPort: true,
    allowedHosts: [
      'jazlyn-leafier-tiffiny.ngrok-free.dev',
      '.ngrok-free.app',
      '.ngrok.io',
      '.loca.lt'
    ],
  }
});
