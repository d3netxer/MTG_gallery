// Sample data builder for the first runnable version.
//
// This is a SCALED-DOWN stand-in for the real eng-review task T2. Instead of
// streaming the 259 MB Scryfall `unique_artwork` bulk export, it fetches a
// handful of notable artists live from the Scryfall search API using
// `unique=art` (the API-side equivalent of the unique_artwork dataset).
// It produces the exact same output shape the real pipeline will, so the
// homepage and artist pages render against real data today.
//
// Run: npm run build:sample

import { writeFile, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { assignSlugs } from '../src/lib/slug.ts';
import { BAKE_LIMIT } from '../src/lib/types.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = join(ROOT, 'src', 'data');
const ARTISTS_DIR = join(DATA_DIR, 'artists');
const OVERFLOW_DIR = join(ROOT, 'public', 'data', 'overflow');

// Curated sample. `nft` flags artists with a known NFT presence (real-world:
// Seb McKinnon and Noah Bradley both sell digital work). The floor values are
// placeholders until the live OpenSea edge function (T6) lands.
const SAMPLE_ARTISTS = [
  { name: 'Rebecca Guay' },
  { name: 'John Avon' },
  { name: 'Seb McKinnon', nft: 0.42 },
  { name: 'Terese Nielsen' },
  { name: 'Volkan Baga' },
  { name: 'Noah Bradley', nft: 0.18 },
  { name: 'Magali Villeneuve' },
  { name: 'Chris Rahn' },
  { name: 'Kev Walker' },
  { name: 'Mark Tedin' },
  { name: 'Greg Staples' },
  { name: 'Igor Kieryluk' },
];

const SCRYFALL = 'https://api.scryfall.com/cards/search';
const HEADERS = {
  'User-Agent': 'MTGArtistIndex/0.1 (sample data builder)',
  Accept: 'application/json',
};
const MAX_CARDS = 60; // keep the sample light; real pipeline keeps all

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cardImage(c) {
  if (c.image_uris) return c.image_uris;
  if (c.card_faces && c.card_faces[0]?.image_uris) return c.card_faces[0].image_uris;
  return null;
}

function dominantColor(cards) {
  const tally = {};
  for (const c of cards) for (const col of c.colors) tally[col] = (tally[col] ?? 0) + 1;
  const entries = Object.entries(tally);
  if (entries.length === 0) return 'C';
  entries.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return entries[0][0];
}

function primaryEra(cards) {
  const tally = {};
  for (const c of cards) {
    const decade = c.year < 2000 ? '1990s' : `${Math.floor(c.year / 10) * 10}s`;
    tally[decade] = (tally[decade] ?? 0) + 1;
  }
  const entries = Object.entries(tally);
  if (entries.length === 0) return 'Unknown';
  entries.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return entries[0][0];
}

async function fetchArtist(name) {
  const url = `${SCRYFALL}?unique=art&order=released&dir=asc&q=${encodeURIComponent(`artist:"${name}"`)}`;
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) {
    console.warn(`  ! ${name}: HTTP ${res.status} — skipping`);
    return [];
  }
  const json = await res.json();
  const cards = (json.data ?? [])
    .map((c) => {
      const img = cardImage(c);
      if (!img) return null;
      return {
        name: c.name,
        set: c.set_name,
        setCode: (c.set ?? '').toUpperCase(),
        year: c.released_at ? Number(c.released_at.slice(0, 4)) : 0,
        colors: c.colors ?? [],
        image: img.normal,
        artCrop: img.art_crop,
      };
    })
    .filter(Boolean)
    .filter((c) => c.year > 0);
  return cards.slice(0, MAX_CARDS);
}

async function main() {
  await rm(ARTISTS_DIR, { recursive: true, force: true });
  await rm(OVERFLOW_DIR, { recursive: true, force: true });
  await mkdir(ARTISTS_DIR, { recursive: true });
  await mkdir(OVERFLOW_DIR, { recursive: true });

  const slugs = assignSlugs(SAMPLE_ARTISTS.map((a) => a.name));
  const index = [];

  for (const artist of SAMPLE_ARTISTS) {
    process.stdout.write(`  fetching ${artist.name} ... `);
    const cards = await fetchArtist(artist.name);
    if (cards.length === 0) {
      console.log('no cards');
      continue;
    }
    const slug = slugs.get(artist.name);
    const dom = dominantColor(cards);
    const era = primaryEra(cards);
    const preview = cards[cards.length - 1].artCrop || cards[0].artCrop;

    const entry = {
      slug,
      displayName: artist.name,
      cardCount: cards.length,
      hasNFTs: Boolean(artist.nft),
      dominantColor: dom,
      primaryEra: era,
      previewImage: preview,
    };
    index.push(entry);

    const stripped = cards.map(({ artCrop, ...rest }) => rest);
    const baked = stripped.slice(0, BAKE_LIMIT);
    const overflow = stripped.slice(BAKE_LIMIT);
    const detail = {
      ...entry,
      sampleFloorEth: artist.nft ?? null,
      bakedCards: baked,
      overflowCount: overflow.length,
    };
    await writeFile(join(ARTISTS_DIR, `${slug}.json`), JSON.stringify(detail, null, 2));
    if (overflow.length) {
      await writeFile(join(OVERFLOW_DIR, `${slug}.json`), JSON.stringify(overflow));
    }
    console.log(`${cards.length} cards [${dom}/${era}]`);
    await sleep(120); // be polite to Scryfall
  }

  index.sort((a, b) => a.displayName.localeCompare(b.displayName));
  await writeFile(join(DATA_DIR, 'artists.json'), JSON.stringify(index, null, 2));
  console.log(`\nWrote ${index.length} artists to src/data/artists.json`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
