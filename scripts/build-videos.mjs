// Image-to-video generation (gallery "Live" clips).
//
// Turns selected card images into short (~6s) clips via Replicate's
// minimax/video-01 model, downloads the mp4s into public/data/video/, and
// writes public/data/video-manifest.json mapping each card IMAGE URL -> clip
// path. The gallery (GalleryView.astro) fetches that manifest and plays a clip
// whenever the current slide has one; otherwise it shows the still card.
//
// This is deliberately a build step, NOT a runtime call: image-to-video is
// slow (~1-4 min/clip) and costs money (~$0.50/clip), so generating for all
// 50k+ artworks is infeasible. Generate a scoped, cached set and grow it.
//
//   REPLICATE_API_TOKEN=... npm run build:videos -- --room dragon --limit 5
//   npm run build:videos -- --artist seb-mckinnon --limit 8
//   npm run build:videos -- --room dragon --limit 5 --dry-run
//
// Requires REPLICATE_API_TOKEN (loaded from .env via --env-file). Re-runs are
// incremental: cards already in the manifest are skipped.

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createWriteStream } from 'node:fs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = join(ROOT, 'src', 'data');
const VIDEO_DIR = join(ROOT, 'public', 'data', 'video');
const MANIFEST = join(ROOT, 'public', 'data', 'video-manifest.json');

const MODEL = 'minimax/video-01'; // https://replicate.com/minimax/video-01/api
// A faithful, low-key animation brief — subtle life, not a reinterpretation.
const PROMPT =
  'Subtle cinematic motion brings this fantasy illustration to life: gentle ' +
  'parallax, drifting embers and dust, flickering light and slow atmospheric ' +
  'movement. Keep the composition, characters and style faithful to the image.';

function parseArgs(argv) {
  const args = { limit: 3, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--room') args.room = argv[++i];
    else if (a === '--artist') args.artist = argv[++i];
    else if (a === '--limit') args.limit = Number(argv[++i]);
    else if (a === '--dry-run') args.dryRun = true;
  }
  return args;
}

/** Collect {image, title} for the requested scope from the built JSON data. */
async function collectTargets(args) {
  if (args.room) {
    const file = join(DATA_DIR, 'rooms', `${args.room}.json`);
    if (!existsSync(file)) throw new Error(`room not built: ${file} (run npm run build:data)`);
    const room = JSON.parse(await readFile(file, 'utf8'));
    return room.baked.map((a) => ({ image: a.image, title: a.name }));
  }
  if (args.artist) {
    const file = join(DATA_DIR, 'artists', `${args.artist}.json`);
    if (!existsSync(file)) throw new Error(`artist not built: ${file} (run npm run build:data)`);
    const artist = JSON.parse(await readFile(file, 'utf8'));
    return artist.bakedCards.map((c) => ({ image: c.image, title: c.name }));
  }
  throw new Error('specify --room <slug> or --artist <slug>');
}

const keyFor = (url) => createHash('sha1').update(url).digest('hex').slice(0, 16);

async function loadManifest() {
  if (!existsSync(MANIFEST)) return {};
  try {
    return JSON.parse(await readFile(MANIFEST, 'utf8'));
  } catch {
    return {};
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Create a prediction and poll until it finishes; returns the output video URL. */
async function generate(token, imageUrl) {
  const res = await fetch(`https://api.replicate.com/v1/models/${MODEL}/predictions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ input: { prompt: PROMPT, first_frame_image: imageUrl, prompt_optimizer: true } }),
  });
  if (!res.ok) throw new Error(`create prediction: HTTP ${res.status} ${await res.text()}`);
  let pred = await res.json();

  const pollUrl = pred.urls?.get;
  while (pred.status !== 'succeeded' && pred.status !== 'failed' && pred.status !== 'canceled') {
    await sleep(5000);
    const p = await fetch(pollUrl, { headers: { Authorization: `Bearer ${token}` } });
    if (!p.ok) throw new Error(`poll: HTTP ${p.status}`);
    pred = await p.json();
    process.stdout.write('.');
  }
  process.stdout.write('\n');
  if (pred.status !== 'succeeded') throw new Error(`prediction ${pred.status}: ${pred.error ?? ''}`);
  // minimax/video-01 returns a single URL string.
  return Array.isArray(pred.output) ? pred.output[0] : pred.output;
}

async function download(url, dest) {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`download: HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const targets = (await collectTargets(args)).slice(0, args.limit);
  const manifest = await loadManifest();
  const todo = targets.filter((t) => !manifest[t.image]);

  console.log(
    `Scope: ${args.room ? `room=${args.room}` : `artist=${args.artist}`} | ` +
      `${targets.length} card(s), ${todo.length} new (skipping ${targets.length - todo.length} already done)`
  );

  if (args.dryRun) {
    for (const t of todo) console.log(`  would animate: ${t.title}`);
    console.log(`\nDry run — no API calls. Estimated cost ~$${(todo.length * 0.5).toFixed(2)} for ${todo.length} clip(s).`);
    return;
  }
  if (!todo.length) {
    console.log('Nothing to do.');
    return;
  }

  const token = process.env.REPLICATE_API_TOKEN;
  if (!token) throw new Error('REPLICATE_API_TOKEN not set (add it to .env; run via: npm run build:videos -- ...)');

  await mkdir(VIDEO_DIR, { recursive: true });
  let done = 0;
  for (const t of todo) {
    const key = keyFor(t.image);
    const rel = `/data/video/${key}.mp4`;
    try {
      console.log(`[${done + 1}/${todo.length}] ${t.title}`);
      const out = await generate(token, t.image);
      await download(out, join(VIDEO_DIR, `${key}.mp4`));
      manifest[t.image] = rel;
      await writeFile(MANIFEST, JSON.stringify(manifest, null, 2) + '\n'); // persist after each (resumable)
      done++;
    } catch (e) {
      console.warn(`  ✗ ${t.title}: ${e.message}`);
    }
  }
  console.log(`\nDone: ${done}/${todo.length} clip(s) → public/data/video/, manifest → public/data/video-manifest.json`);
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
