// Real data pipeline (eng-review T2).
//
// Streams Scryfall's `unique_artwork` bulk export (~259 MB) and produces the
// site's data: a homepage index, per-artist baked-card files, and overflow
// files for prolific artists. Never holds the whole 259 MB in memory — the
// JSON array is parsed as a stream.
//
//   npm run build:data
//
// Flow:
//   bulk-data manifest ─► download unique_artwork (cached by updated_at)
//        │ stream-parse (stream-json), one card at a time
//        ▼
//   group by artist ─► normalize via curated-artists.json
//        │ dominant color = mode(colors), primary era = peak decade
//        ▼
//   src/data/artists.json (index)
//   src/data/artists/{slug}.json (first 48 cards, baked)
//   public/data/overflow/{slug}.json (cards 49+, lazy)

import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { writeFile, mkdir, rm, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import StreamJson from 'stream-json';
import StreamArrayMod from 'stream-json/streamers/StreamArray.js';
const { parser } = StreamJson as unknown as { parser: () => NodeJS.ReadWriteStream };
const { streamArray } = StreamArrayMod as unknown as { streamArray: () => NodeJS.ReadWriteStream };
import { assignSlugs } from '../src/lib/slug.ts';
import { BAKE_LIMIT } from '../src/lib/types.ts';
import { applyTag, finalize, emptyStats, taggingKept, type RawArtTag, type ArtworkTag } from '../src/lib/art-tags.ts';
import { deriveRooms, type TagNode, type RoomCandidate } from '../src/lib/rooms.ts';
import { findNameVariants, findOrphanCollections, formatCurationReport } from '../src/lib/curation.ts';
import { roomArtworks } from '../src/lib/room-art.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE_DIR = join(ROOT, '.cache');
const DATA_DIR = join(ROOT, 'src', 'data');
const ARTISTS_DIR = join(DATA_DIR, 'artists');
const OVERFLOW_DIR = join(ROOT, 'public', 'data', 'overflow');
const BULK_FILE = join(CACHE_DIR, 'unique-artwork.json');
const META_FILE = join(CACHE_DIR, 'bulk-meta.json');
const ART_TAGS_FILE = join(CACHE_DIR, 'art-tags.json');
const ART_TAGS_META = join(CACHE_DIR, 'art-tags-meta.json');
const CURATED_FILE = join(ROOT, 'curated-artists.json');
const ROOMS_MANIFEST = join(ROOT, 'rooms.json');
const ROOM_MEMBERS_FILE = join(DATA_DIR, 'room-members.json');
const ROOMS_DIR = join(DATA_DIR, 'rooms'); // one baked file per published room
const ROOMS_INDEX_FILE = join(DATA_DIR, 'rooms-index.json');
const ROOM_OVERFLOW_DIR = join(ROOT, 'public', 'data', 'room-overflow');
const CURATION_REPORT = join(ROOT, 'curation-report.md');
const MIN_ROOM_COUNT = 12; // a room needs at least this many strongly-tagged artworks
const MAX_ROOM_COUNT = 800; // above this a tag is too broad to be a museum room (e.g. "character")
const BOOTSTRAP_ROOMS = 40; // top-N candidates seeded into a new rooms.json
// Demographic/structural tags that aren't evocative rooms (excluded from the
// bootstrap even when under MAX_ROOM_COUNT). Curators can still pin them.
const ROOM_STOPLIST = new Set([
  'character', 'male', 'female', 'human', 'animal', 'person', 'creature',
  'external-ip', 'planar-origin', 'plane', 'location', 'no-creatures',
  'multiple-creatures', 'group', 'mtg-universe',
]);

const HEADERS = {
  'User-Agent': 'MTGArtistIndex/0.1 (data builder)',
  Accept: 'application/json',
};

interface RawCard {
  artist?: string;
  name: string;
  set_name?: string;
  set?: string;
  released_at?: string;
  colors?: string[];
  layout?: string;
  illustration_id?: string;
  image_uris?: { normal?: string; art_crop?: string };
  card_faces?: Array<{ illustration_id?: string; image_uris?: { normal?: string; art_crop?: string } }>;
}

interface CuratedEntry {
  scryfallName: string;
  canonicalDisplayName: string;
  openSeaCollections?: string[];
  walletAddress?: string;
  sampleFloorEth?: number;
}

interface Card {
  name: string;
  set: string;
  setCode: string;
  year: number;
  colors: string[];
  image: string;
  artCrop: string;
  illustrationId: string;
}

interface ManifestEntry {
  type: string;
  updated_at: string;
  download_uri: string;
  size: number;
}

async function getManifest(): Promise<ManifestEntry[]> {
  const res = await fetch('https://api.scryfall.com/bulk-data', { headers: HEADERS });
  if (!res.ok) throw new Error(`bulk-data manifest: HTTP ${res.status}`);
  const json = (await res.json()) as { data: ManifestEntry[] };
  return json.data;
}

function findEntry(manifest: ManifestEntry[], type: string): ManifestEntry {
  const entry = manifest.find((d) => d.type === type);
  if (!entry) throw new Error(`${type} not found in manifest`);
  return entry;
}

/** Download a bulk export to `file`, skipping if cached `updated_at` matches. */
async function ensureBulk(entry: ManifestEntry, file: string, metaFile: string) {
  await mkdir(CACHE_DIR, { recursive: true });
  let cachedUpdatedAt = '';
  if (existsSync(metaFile)) {
    try {
      cachedUpdatedAt = JSON.parse(await readFile(metaFile, 'utf8')).updated_at ?? '';
    } catch {}
  }
  if (existsSync(file) && cachedUpdatedAt === entry.updated_at) {
    console.log(`Using cached ${entry.type} (updated ${entry.updated_at.slice(0, 10)})`);
    return;
  }
  console.log(`Downloading ${entry.type} (~${Math.round(entry.size / 1e6)} MB)…`);
  const res = await fetch(entry.download_uri, { headers: HEADERS });
  if (!res.ok || !res.body) throw new Error(`download ${entry.type}: HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body as any), createWriteStream(file));
  await writeFile(metaFile, JSON.stringify({ updated_at: entry.updated_at }));
  console.log(`${entry.type} download complete.`);
}

interface RawArtTagFull extends RawArtTag {
  id?: string;
}

/**
 * Single stream pass over art_tags that produces everything tag-related:
 *   - byIllustration: illustration_id -> [tags]   (T1, for artwork pages)
 *   - graph:          tagId -> {slug,label,parentIds}  (the DAG, for rooms)
 *   - members:        tagId -> Set<illustration_id>    (strong+valid, for rooms)
 */
async function buildTagIndex(validIllos: Set<string>) {
  const byIllustration = new Map<string, ArtworkTag[]>();
  const stats = emptyStats();
  const graph = new Map<string, TagNode>();
  const members = new Map<string, Set<string>>();

  const stream = createReadStream(ART_TAGS_FILE).pipe(parser()).pipe(streamArray());
  await new Promise<void>((resolve, reject) => {
    stream.on('data', ({ value }: { value: RawArtTagFull }) => {
      applyTag(value, validIllos, byIllustration, stats);
      if (value.id) {
        graph.set(value.id, { id: value.id, slug: value.slug, label: value.label, parentIds: value.parent_ids ?? [] });
        for (const t of value.taggings ?? []) {
          if (!taggingKept(t, validIllos)) continue; // same strong+valid rule as T1
          let set = members.get(value.id);
          if (!set) members.set(value.id, (set = new Set()));
          set.add(t.illustration_id);
        }
      }
    });
    stream.on('end', () => resolve());
    stream.on('error', reject);
  });
  finalize(byIllustration, stats);
  return { byIllustration, stats, graph, members };
}

/**
 * Reconcile derived candidates with the committed rooms.json (the URL
 * contract). Bootstraps a manifest from top candidates on first run; after
 * that, the manifest decides which rooms exist — never deleting a published
 * room just because a refresh dropped its count.
 */
async function resolveRooms(candidates: RoomCandidate[]) {
  const byCount = new Map(candidates.map((c) => [c.slug, c.count]));
  if (!existsSync(ROOMS_MANIFEST)) {
    const seed = candidates.slice(0, BOOTSTRAP_ROOMS).map((c, i) => ({ slug: c.slug, label: c.label, featured: i < 12 }));
    await writeFile(ROOMS_MANIFEST, JSON.stringify({ rooms: seed }, null, 2) + '\n');
    console.log(`Bootstrapped rooms.json with top ${seed.length} candidates — review & commit it (it is the URL contract).`);
    return seed;
  }
  const manifest = JSON.parse(await readFile(ROOMS_MANIFEST, 'utf8')) as { rooms: { slug: string; label: string; featured?: boolean }[] };
  const known = new Set(manifest.rooms.map((r) => r.slug));
  const below = manifest.rooms.filter((r) => (byCount.get(r.slug) ?? 0) < MIN_ROOM_COUNT);
  if (below.length) {
    console.warn(`⚠ ${below.length} manifest room(s) now below ${MIN_ROOM_COUNT} (kept, not deleted — stable URLs): ${below.map((r) => r.slug).slice(0, 6).join(', ')}`);
  }
  const fresh = candidates.filter((c) => !known.has(c.slug)).slice(0, 10);
  if (fresh.length) {
    console.log(`ℹ ${fresh.length} new room candidate(s) NOT auto-added (add to rooms.json by PR): ${fresh.map((c) => `${c.slug}(${c.count})`).join(', ')}`);
  }
  return manifest.rooms;
}

async function loadCurated(): Promise<Map<string, CuratedEntry>> {
  const map = new Map<string, CuratedEntry>();
  if (!existsSync(CURATED_FILE)) return map;
  const arr = JSON.parse(await readFile(CURATED_FILE, 'utf8')) as CuratedEntry[];
  for (const e of arr) map.set(e.scryfallName, e);
  return map;
}

function cardFrom(raw: RawCard): Card | null {
  const face = raw.card_faces?.[0];
  const img = raw.image_uris ?? face?.image_uris;
  if (!img?.normal || !img.art_crop) return null;
  const year = raw.released_at ? Number(raw.released_at.slice(0, 4)) : 0;
  if (!year) return null;
  const illustrationId = raw.illustration_id ?? face?.illustration_id ?? '';
  return {
    name: raw.name,
    set: raw.set_name ?? '',
    setCode: (raw.set ?? '').toUpperCase(),
    year,
    colors: raw.colors ?? [],
    image: img.normal,
    artCrop: img.art_crop,
    illustrationId,
  };
}

function dominantColor(cards: Card[]): string {
  const tally: Record<string, number> = {};
  for (const c of cards) for (const col of c.colors) tally[col] = (tally[col] ?? 0) + 1;
  const entries = Object.entries(tally);
  if (entries.length === 0) return 'C';
  entries.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return entries[0][0];
}

function primaryEra(cards: Card[]): string {
  const tally: Record<string, number> = {};
  for (const c of cards) {
    const decade = c.year < 2000 ? '1990s' : `${Math.floor(c.year / 10) * 10}s`;
    tally[decade] = (tally[decade] ?? 0) + 1;
  }
  const entries = Object.entries(tally);
  entries.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return entries[0][0];
}

async function main() {
  const manifest = await getManifest();
  await ensureBulk(findEntry(manifest, 'unique_artwork'), BULK_FILE, META_FILE);
  await ensureBulk(findEntry(manifest, 'art_tags'), ART_TAGS_FILE, ART_TAGS_META);
  const curated = await loadCurated();

  // Stream-parse the bulk array, grouping cards by (canonical) artist and
  // collecting the set of valid illustration_ids (the join key for art_tags).
  const byArtist = new Map<string, Card[]>();
  const validIllos = new Set<string>();
  const seenScryfallNames = new Set<string>(); // raw artist credits, for orphan-collection detection
  const cardByIllo = new Map<string, Card>(); // illustration_id -> card, for room art tiles
  const artistsByIllo = new Map<string, string[]>(); // illustration_id -> canonical artist names
  let raw = 0;
  let kept = 0;

  const stream = createReadStream(BULK_FILE).pipe(parser()).pipe(streamArray());
  await new Promise<void>((resolve, reject) => {
    stream.on('data', ({ value }: { value: RawCard }) => {
      raw++;
      const card = cardFrom(value);
      if (!card) return;
      if (card.illustrationId) {
        validIllos.add(card.illustrationId);
        cardByIllo.set(card.illustrationId, card); // reference, not a copy — cheap
      }
      if (!value.artist) return;
      // Split collaborations ("A & B") so each artist gets credit.
      for (const name of value.artist.split(' & ').map((s) => s.trim())) {
        if (!name) continue;
        seenScryfallNames.add(name);
        const canonical = curated.get(name)?.canonicalDisplayName ?? name;
        let bucket = byArtist.get(canonical);
        if (!bucket) byArtist.set(canonical, (bucket = []));
        bucket.push(card);
        if (card.illustrationId) {
          let names = artistsByIllo.get(card.illustrationId);
          if (!names) artistsByIllo.set(card.illustrationId, (names = []));
          names.push(canonical);
        }
        kept++;
      }
    });
    stream.on('end', () => resolve());
    stream.on('error', reject);
  });

  console.log(`Parsed ${raw.toLocaleString()} cards → ${byArtist.size} artists (${kept.toLocaleString()} credits), ${validIllos.size.toLocaleString()} illustrations`);

  // Invert art_tags (tag -> artworks) into illustration_id -> [tags],
  // plus the tag DAG + per-tag membership for room derivation.
  const { byIllustration: tagsByIllo, stats: tagStats, graph, members } = await buildTagIndex(validIllos);
  const joinPct = ((tagStats.illustrationsTagged / Math.max(validIllos.size, 1)) * 100).toFixed(1);
  const consideredStrong = tagStats.kept + tagStats.orphan;
  const reversePct = ((tagStats.kept / Math.max(consideredStrong, 1)) * 100).toFixed(1);
  console.log(
    `Art tags: ${tagStats.tags.toLocaleString()} tags, ${tagStats.taggings.toLocaleString()} taggings ` +
      `(${tagStats.belowWeight.toLocaleString()} weak dropped, ${tagStats.orphan.toLocaleString()} orphan dropped)`
  );
  console.log(`  join coverage: ${joinPct}% of illustrations have a strong+ tag | reverse coverage: ${reversePct}% of strong taggings matched an artwork`);
  // Reverse coverage is the join-KEY health metric: if strong taggings fail to
  // match a valid illustration_id, the join is broken. Join coverage is just
  // tagging DENSITY at the current weight threshold (most taggings are 'median'
  // and intentionally dropped), so a low value there is a tuning signal, not a bug.
  const REVERSE_THRESHOLD = 80; // T9 will hard-fail this gate
  if (Number(reversePct) < REVERSE_THRESHOLD) {
    console.warn(`⚠ reverse coverage ${reversePct}% below ${REVERSE_THRESHOLD}% — illustration_id join key likely wrong`);
  }
  const medianPct = ((tagStats.belowWeight / Math.max(tagStats.taggings, 1)) * 100).toFixed(0);
  console.log(`  note: ${medianPct}% of taggings are weak/'median' (dropped). Weight threshold is a room-tuning knob for T2.`);
  const tagsObj: Record<string, ArtworkTag[]> = {};
  for (const [illo, list] of tagsByIllo) tagsObj[illo] = list;
  await writeFile(join(DATA_DIR, 'artwork-tags.json'), JSON.stringify(tagsObj));
  console.log(`Wrote ${tagStats.illustrationsTagged.toLocaleString()} tagged illustrations → src/data/artwork-tags.json`);

  // Derive rooms by rolling tag membership up the DAG, then reconcile with the
  // committed rooms.json manifest (the URL contract).
  const { rooms, candidates } = deriveRooms(graph, members, {
    minCount: MIN_ROOM_COUNT,
    maxCount: MAX_ROOM_COUNT,
    stoplist: ROOM_STOPLIST,
  });
  console.log(`Derived ${candidates.length} room candidates (>=${MIN_ROOM_COUNT} artworks). Top: ${candidates.slice(0, 8).map((c) => `${c.slug}(${c.count})`).join(', ')}`);
  const published = await resolveRooms(candidates);
  const roomMembers: Record<string, string[]> = {};
  let publishedWithMembers = 0;
  for (const r of published) {
    const room = rooms.get(r.slug);
    roomMembers[r.slug] = room ? [...room.members] : [];
    if (roomMembers[r.slug].length) publishedWithMembers++;
  }
  await writeFile(ROOM_MEMBERS_FILE, JSON.stringify(roomMembers));
  console.log(`Wrote ${published.length} published rooms (${publishedWithMembers} non-empty) → src/data/room-members.json`);

  // Deterministic slug assignment; warn on collisions (curation candidates).
  const names = [...byArtist.keys()].sort((a, b) => a.localeCompare(b));
  const slugMap = assignSlugs(names);
  const collisions = [...slugMap.values()].filter((s) => /-\d+$/.test(s));
  if (collisions.length) {
    console.warn(`⚠ ${collisions.length} slug collisions auto-suffixed (add curated-artists.json entries): ${collisions.slice(0, 8).join(', ')}${collisions.length > 8 ? '…' : ''}`);
  }

  await rm(ARTISTS_DIR, { recursive: true, force: true });
  await rm(OVERFLOW_DIR, { recursive: true, force: true });
  await mkdir(ARTISTS_DIR, { recursive: true });
  await mkdir(OVERFLOW_DIR, { recursive: true });

  const index = [];
  for (const name of names) {
    const cards = byArtist.get(name)!;
    cards.sort((a, b) => b.year - a.year || a.name.localeCompare(b.name)); // newest first
    const slug = slugMap.get(name)!;
    const cur = curated.get(name);
    const hasNFTs = Boolean(cur?.openSeaCollections?.length);

    const entryRecord = {
      slug,
      displayName: name,
      cardCount: cards.length,
      hasNFTs,
      dominantColor: dominantColor(cards),
      primaryEra: primaryEra(cards),
      previewImage: cards[0].image,
    };
    index.push(entryRecord);

    const baked = cards.slice(0, BAKE_LIMIT).map(({ artCrop, ...c }) => c);
    const overflow = cards.slice(BAKE_LIMIT).map(({ artCrop, ...c }) => c);

    await writeFile(
      join(ARTISTS_DIR, `${slug}.json`),
      JSON.stringify({ ...entryRecord, sampleFloorEth: cur?.sampleFloorEth ?? null, bakedCards: baked, overflowCount: overflow.length })
    );
    if (overflow.length) {
      await writeFile(join(OVERFLOW_DIR, `${slug}.json`), JSON.stringify(overflow));
    }
  }

  index.sort((a, b) => a.displayName.localeCompare(b.displayName));
  await writeFile(join(DATA_DIR, 'artists.json'), JSON.stringify(index));
  const nft = index.filter((a) => a.hasNFTs).length;
  console.log(`Wrote ${index.length} artists (${nft} with NFTs) → src/data/artists.json`);

  // Room pages (rooms route): join each published room's illustration_ids to
  // card art + artist slugs, bake the first BAKE_LIMIT, overflow the rest —
  // mirroring the per-artist page contract. `published` is the URL contract,
  // so every published room gets a page even if its membership is now empty.
  await rm(ROOMS_DIR, { recursive: true, force: true });
  await rm(ROOM_OVERFLOW_DIR, { recursive: true, force: true });
  await mkdir(ROOMS_DIR, { recursive: true });
  await mkdir(ROOM_OVERFLOW_DIR, { recursive: true });

  const roomIndex = [];
  for (const r of published) {
    const memberSet = rooms.get(r.slug)?.members ?? new Set<string>();
    const artworks = roomArtworks(memberSet, { cardByIllo, artistsByIllo, slugOf: slugMap });
    const baked = artworks.slice(0, BAKE_LIMIT);
    const overflow = artworks.slice(BAKE_LIMIT);
    const featured = r.featured ?? false;
    await writeFile(
      join(ROOMS_DIR, `${r.slug}.json`),
      JSON.stringify({ slug: r.slug, label: r.label, featured, count: artworks.length, baked, overflowCount: overflow.length })
    );
    if (overflow.length) await writeFile(join(ROOM_OVERFLOW_DIR, `${r.slug}.json`), JSON.stringify(overflow));
    roomIndex.push({ slug: r.slug, label: r.label, featured, count: artworks.length, previewImage: artworks[0]?.image ?? null });
  }
  // Featured first, then richest rooms — the order the index page renders in.
  roomIndex.sort((a, b) => Number(b.featured) - Number(a.featured) || b.count - a.count || a.label.localeCompare(b.label));
  await writeFile(ROOMS_INDEX_FILE, JSON.stringify(roomIndex));
  const nonEmptyRooms = roomIndex.filter((r) => r.count > 0).length;
  console.log(`Wrote ${roomIndex.length} room pages (${nonEmptyRooms} non-empty) → src/data/rooms/, rooms-index.json`);

  // Advisory curation report (TODOS.md): suspected name variants + orphan
  // curated collections. Never fails the build — it's a worklist for a human.
  // `names` is already sorted, so variant pairing is deterministic.
  const variants = findNameVariants(names);
  const orphans = findOrphanCollections([...curated.values()], seenScryfallNames);
  const generatedAt = new Date().toISOString().slice(0, 10); // date-only keeps same-day rebuilds stable
  await writeFile(CURATION_REPORT, formatCurationReport(variants, orphans, generatedAt));
  console.log(`Curation report: ${variants.length} suspected name-variant pair(s), ${orphans.length} orphan collection(s) → curation-report.md`);
  if (orphans.length) {
    console.warn(`⚠ ${orphans.length} curated entr${orphans.length === 1 ? 'y' : 'ies'} matched no artist (fix scryfallName): ${orphans.map((o) => o.scryfallName).join(', ')}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
