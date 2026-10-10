import { defineConfig } from 'vite';
import glsl from 'vite-plugin-glsl';

export default defineConfig({
  plugins: [
    // Resolves `#include path/to/chunk.glsl;` in shaders. Three.js `#include <chunk>` is left alone.
    glsl({ watch: true }),
  ],
  server: {
    port: 3000,
    strictPort: true,
    // Listen on all interfaces and accept any Host header (LAN IPs, tunnels, custom domains).
    host: '0.0.0.0',
    allowedHosts: true,
  },
  preview: {
    port: 3000,
    strictPort: true,
    // Listen on all interfaces and accept any Host header (LAN IPs, tunnels, custom domains).
    host: '0.0.0.0',
    allowedHosts: true,
  },
});
