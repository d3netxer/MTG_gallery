import { defineConfig } from 'astro/config';

// First runnable version: static output. The Vercel adapter + hybrid output
// and the /api/nft-prices edge function come later (eng-review tasks T6/T9).
export default defineConfig({
  site: 'https://mtg-artist-index.local',
  // Homepage is now the curated living gallery; the rooms/artists browser is
  // parked at /browse. Keep the old /rooms entry landing on the browser.
  redirects: {
    '/rooms': '/browse',
  },
});
