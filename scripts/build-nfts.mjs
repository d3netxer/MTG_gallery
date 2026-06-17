// NFT enrichment step (part of T6, build-time variant).
//
// For each curated artist with `nftTokens`, fetch the real NFT (title, image,
// OpenSea link) and the collection floor price from the OpenSea API, then
// patch them into that artist's already-built detail JSON. No fabricated data:
// if a token or collection can't be fetched, it's simply omitted.
//
//   node --env-file=.env scripts/build-nfts.mjs   (run AFTER build:data)

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { toSlug } from '../src/lib/slug.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ARTISTS_DIR = join(ROOT, 'src', 'data', 'artists');
const CURATED = join(ROOT, 'curated-artists.json');
const KEY = process.env.OPENSEA_API_KEY;
const BASE = 'https://api.opensea.io/api/v2';

if (!KEY) {
  console.error('OPENSEA_API_KEY missing. Run: node --env-file=.env scripts/build-nfts.mjs');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const headers = { 'X-API-KEY': KEY, Accept: 'application/json' };

async function getJson(url) {
  const res = await fetch(url, { headers });
  if (!res.ok) return null;
  return res.json();
}

async function collectionFloor(slug) {
  const d = await getJson(`${BASE}/collections/${slug}/stats`);
  await sleep(1100);
  const f = d?.total?.floor_price;
  return typeof f === 'number' && f > 0 ? f : null;
}

async function fetchToken(t) {
  const d = await getJson(`${BASE}/chain/${t.chain}/contract/${t.contract}/nfts/${t.id}`);
  await sleep(1100);
  const n = d?.nft;
  if (!n?.image_url) return null;
  return {
    name: n.name || `#${t.id}`,
    image: n.image_url,
    url: n.opensea_url || `https://opensea.io/assets/${t.chain}/${t.contract}/${t.id}`,
  };
}

async function main() {
  const curated = JSON.parse(await readFile(CURATED, 'utf8'));
  let patched = 0;
  for (const entry of curated) {
    if (!entry.nftTokens?.length) continue;
    const slug = toSlug(entry.canonicalDisplayName);
    const file = join(ARTISTS_DIR, `${slug}.json`);
    if (!existsSync(file)) {
      console.warn(`  ! no detail file for ${entry.canonicalDisplayName} (${slug}) — skipping`);
      continue;
    }
    process.stdout.write(`  ${entry.canonicalDisplayName}: `);
    const nfts = [];
    for (const t of entry.nftTokens) {
      const nft = await fetchToken(t);
      if (nft) nfts.push(nft);
    }
    const floor = entry.openSeaCollections?.[0]
      ? await collectionFloor(entry.openSeaCollections[0])
      : null;

    const detail = JSON.parse(await readFile(file, 'utf8'));
    detail.nfts = nfts;
    detail.nftFloorEth = floor;
    detail.nftCollection = entry.openSeaCollections?.[0] ?? null;
    await writeFile(file, JSON.stringify(detail));
    console.log(`${nfts.length} NFTs, floor ${floor ?? '—'} ETH`);
    patched++;
  }
  console.log(`\nPatched ${patched} artist(s) with live NFT data.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
