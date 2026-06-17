// Vibe restyling — run a room's card art through an image-to-image model.
//
// A "vibe" is a free-text aesthetic ("neon cyberpunk", "watercolor storybook").
// For each baked card in a room, this sends the REAL card art plus the vibe to
// an edit model (default google/nano-banana) and saves the reimagined image.
// The room page (rooms/[slug].astro) fetches the manifest and, when a user
// applies a vibe, swaps each tile's art to its restyled variant.
//
// Like the video pipeline this is a BUILD step, not a runtime call: a static
// site can't call Replicate live (token + ~15s x 48 cards). Pre-generate vibes
// here; the UI applies them. Live free-text prompts would need a backend proxy.
//
//   REPLICATE_API_TOKEN=... npm run build:vibe -- --room planeswalker --vibe "neon cyberpunk" --limit 5
//   npm run build:vibe -- --room planeswalker --vibe "gothic noir" --limit 5 --dry-run
//
// Incremental: a card already restyled for that vibe is skipped on re-run.

import { createHash } from 'node:crypto';
import { existsSync, createWriteStream } from 'node:fs';
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = join(ROOT, 'src', 'data');
const VIBE_DIR = join(ROOT, 'public', 'data', 'vibe');
const MANIFEST = join(ROOT, 'public', 'data', 'vibe-manifest.json');

// model -> the input field that takes the source image (array vs string).
const MODELS = {
  'nano-banana': { id: 'google/nano-banana', imageField: 'image_input', asArray: true },
  'flux-kontext': { id: 'black-forest-labs/flux-kontext-pro', imageField: 'input_image', asArray: false },
};

function parseArgs(argv) {
  const args = { model: 'nano-banana', limit: 5, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--room') args.room = argv[++i];
    else if (a === '--artist') args.artist = argv[++i];
    else if (a === '--vibe') args.vibe = argv[++i];
    else if (a === '--model') args.model = argv[++i];
    else if (a === '--limit') args.limit = Number(argv[++i]);
    else if (a === '--dry-run') args.dryRun = true;
  }
  return args;
}

const slugify = (s) =>
  s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function loadManifest() {
  if (!existsSync(MANIFEST)) return {};
  try {
    return JSON.parse(await readFile(MANIFEST, 'utf8'));
  } catch {
    return {};
  }
}

function vibePrompt(vibe) {
  return (
    `Reimagine this fantasy illustration with a ${vibe} aesthetic. Transform the ` +
    `color palette, lighting, mood, and textures to feel ${vibe}, while preserving ` +
    `the original composition, characters, subjects, and framing.`
  );
}

async function createPrediction(token, m, input) {
  // Free Replicate accounts (no payment method) are throttled to ~6 creates/min
  // with a burst of 1, so honor the 429 retry_after instead of failing.
  for (let attempt = 0; attempt < 8; attempt++) {
    const res = await fetch(`https://api.replicate.com/v1/models/${m.id}/predictions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ input }),
    });
    if (res.status === 429) {
      const body = await res.json().catch(() => ({}));
      const wait = ((body.retry_after ?? 10) + 1) * 1000;
      process.stdout.write(`(rate-limited, waiting ${Math.ceil(wait / 1000)}s)`);
      await sleep(wait);
      continue;
    }
    if (!res.ok) throw new Error(`create: HTTP ${res.status} ${await res.text()}`);
    return res.json();
  }
  throw new Error('create: still rate-limited after retries (add a payment method to lift the limit)');
}

async function generate(token, model, imageUrl, vibe) {
  const m = MODELS[model];
  const input = { prompt: vibePrompt(vibe), [m.imageField]: m.asArray ? [imageUrl] : imageUrl };
  let pred = await createPrediction(token, m, input);
  const pollUrl = pred.urls?.get;
  while (!['succeeded', 'failed', 'canceled'].includes(pred.status)) {
    await sleep(3000);
    const p = await fetch(pollUrl, { headers: { Authorization: `Bearer ${token}` } });
    pred = await p.json();
    process.stdout.write('.');
  }
  process.stdout.write('\n');
  if (pred.status !== 'succeeded') throw new Error(`${pred.status}: ${pred.error ?? ''}`);
  return Array.isArray(pred.output) ? pred.output[0] : pred.output;
}

async function download(url, dest) {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`download: HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.vibe) throw new Error('specify --vibe "<text>"');
  if (!MODELS[args.model]) throw new Error(`unknown --model ${args.model} (use: ${Object.keys(MODELS).join(', ')})`);
  const vibeSlug = slugify(args.vibe);
  const targets = (await collectTargets(args)).slice(0, args.limit);

  const manifest = await loadManifest();
  const entry = (manifest[vibeSlug] ??= { label: args.vibe, model: MODELS[args.model].id, images: {} });
  const todo = targets.filter((t) => !entry.images[t.image]);

  console.log(
    `Vibe "${args.vibe}" [${vibeSlug}] via ${MODELS[args.model].id} on ${args.room ? `room=${args.room}` : `artist=${args.artist}`} | ` +
      `${targets.length} card(s), ${todo.length} new`
  );

  if (args.dryRun) {
    for (const t of todo) console.log(`  would restyle: ${t.title}`);
    console.log(`\nDry run — estimated ~$${(todo.length * 0.04).toFixed(2)} for ${todo.length} image(s).`);
    return;
  }
  if (!todo.length) {
    console.log('Nothing to do.');
    return;
  }

  const token = process.env.REPLICATE_API_TOKEN;
  if (!token) throw new Error('REPLICATE_API_TOKEN not set (add it to .env)');

  const outDir = join(VIBE_DIR, vibeSlug);
  await mkdir(outDir, { recursive: true });
  let done = 0;
  for (const t of todo) {
    const key = keyFor(t.image);
    const rel = `/data/vibe/${vibeSlug}/${key}.jpg`;
    try {
      console.log(`[${done + 1}/${todo.length}] ${t.title}`);
      const out = await generate(token, args.model, t.image, args.vibe);
      await download(out, join(outDir, `${key}.jpg`));
      entry.images[t.image] = rel;
      await writeFile(MANIFEST, JSON.stringify(manifest, null, 2) + '\n');
      done++;
    } catch (e) {
      console.warn(`  ✗ ${t.title}: ${e.message}`);
      if (/HTTP 402|Insufficient credit/i.test(e.message)) {
        console.error('\nStopping: Replicate account has no credit. Add a payment method at\n  https://replicate.com/account/billing\nthen re-run this command.');
        break;
      }
    }
  }
  console.log(`\nDone: ${done}/${todo.length} restyled → public/data/vibe/${vibeSlug}/, manifest updated`);
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
