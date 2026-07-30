import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'PicBook',
    short_name: 'PicBook',
    description: 'Cull, organize, and book your travel photos — entirely on your device.',
    start_url: '/',
    display: 'standalone',
    background_color: '#f3f2f2',
    theme_color: '#1f3d5c',
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
      { src: '/icons/icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
