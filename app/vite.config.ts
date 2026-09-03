import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// GitHub Pages sert un site de projet sous /<repo>/. Sans ce prefixe, les
// assets et le service worker sont cherches a la racine du domaine et le
// site reste blanc. A repasser a '/' pour un domaine dedie.
const BASE = process.env.VITE_BASE ?? '/Reel4me/';

export default defineConfig({
  base: BASE,
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      manifest: {
        id: BASE,
        name: 'Reel4me',
        short_name: 'Reel4me',
        description: 'Un feed de cartes de savoir, tech / IA / business.',
        theme_color: '#0a0a0c',
        background_color: '#0a0a0c',
        display: 'standalone',
        orientation: 'portrait',
        scope: BASE,
        start_url: BASE,
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        runtimeCaching: [
          {
            // Les photos Pexels : le feed reste lisible hors ligne.
            urlPattern: /^https:\/\/images\.pexels\.com\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'pexels-images',
              expiration: { maxEntries: 300, maxAgeSeconds: 60 * 60 * 24 * 30 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            // Les videos ne sont volontairement PAS mises en cache : trop
            // lourdes pour le stockage d'un telephone.
            urlPattern: /^https:\/\/[a-z0-9.-]*supabase\.co\/rest\/v1\/cards.*/i,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'cards-api',
              networkTimeoutSeconds: 4,
              expiration: { maxEntries: 40, maxAgeSeconds: 60 * 60 * 24 * 7 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
    }),
  ],
});
