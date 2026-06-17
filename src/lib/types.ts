// Shared data shapes for the artist index.

export const COLOR_NAMES: Record<string, string> = {
  W: 'White',
  U: 'Blue',
  B: 'Black',
  R: 'Red',
  G: 'Green',
  C: 'Colorless',
};

export interface ArtistCard {
  name: string;
  set: string;
  setCode: string;
  year: number;
  colors: string[];
  image: string; // normal card image
}

/** Homepage index record (small — shipped to the client for filtering). */
export interface ArtistIndexEntry {
  slug: string;
  displayName: string;
  cardCount: number;
  hasNFTs: boolean;
  dominantColor: string; // single WUBRGC code (mode), not a union
  primaryEra: string; // e.g. "1990s" — the decade with the most cards
  previewImage: string; // art crop for the tile
}

export const BAKE_LIMIT = 48; // cards baked into static HTML; rest lazy-load

/**
 * Per-artist detail. `bakedCards` (<= BAKE_LIMIT) render into the static HTML
 * for SEO + instant paint; if `overflowCount > 0`, the remaining cards live in
 * /data/overflow/{slug}.json and are fetched on "Load more". Keeps both build
 * memory and fat-tail page weight bounded.
 */
export interface NftItem {
  name: string;
  image: string;
  url: string; // link to the live OpenSea listing
}

export interface ArtistDetail extends ArtistIndexEntry {
  bakedCards: ArtistCard[];
  overflowCount: number;
  sampleFloorEth: number | null; // placeholder until live edge fn (T6)
  // Live NFT data (patched by build:nfts from the OpenSea API). Optional —
  // only present for curated artists with verified tokens.
  nfts?: NftItem[];
  nftFloorEth?: number | null;
  nftCollection?: string | null;
}
