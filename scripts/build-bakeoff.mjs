// Image-to-video model bake-off.
//
// Runs 16 curated cards through 16 DIFFERENT Replicate image-to-video models,
// one model per card, and records which model produced each clip so the
// /bakeoff page can label them. Models that accept a text prompt get the card's
// oracle text as the prompt; image-only models (SVD) ride on the art alone.
//
//   REPLICATE_API_TOKEN=... npm run build:bakeoff
//   npm run build:bakeoff -- --dry-run
//
// Resumable: a card whose clip already exists is skipped. The 16 models have 4
// different image-field names and different output shapes, handled per-model
// below. If a model rejects an input (422), we retry with progressively simpler
// input rather than dropping the card.

import { existsSync, createWriteStream } from 'node:fs';
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLIP_DIR = join(ROOT, 'public', 'data', 'bakeoff');
const MANIFEST = join(ROOT, 'src', 'data', 'bakeoff.json');

// model -> image-input field name (verified against the live API), prompt
// support, and an optional duration hint we attempt then drop if rejected.
const MODELS = {
  'luma/ray-flash-2-540p': { img: 'start_image', prompt: true, extra: { duration: '5s' } },
  'pixverse/pixverse-v4.5': { img: 'image', prompt: true, extra: { duration: 5 } },
  'wan-video/wan-2.5-i2v': { img: 'image', prompt: true, extra: { duration: 5 } },
  'kwaivgi/kling-v1.6-standard': { img: 'start_image', prompt: true, extra: { duration: 5 } },
  'minimax/video-01-live': { img: 'first_frame_image', prompt: true },
  'wavespeedai/wan-2.1-i2v-480p': { img: 'image', prompt: true },
  'lightricks/ltx-video': { img: 'image', prompt: true },
  'ali-vilab/i2vgen-xl': { img: 'image', prompt: true },
  'stability-ai/stable-video-diffusion': { img: 'input_image', prompt: false },
  'minimax/video-01': { img: 'first_frame_image', prompt: true },
  'google/veo-3-fast': { img: 'image', prompt: true },
  'bytedance/seedance-1-lite': { img: 'image', prompt: true, extra: { duration: 5 } },
  'bytedance/seedance-1-pro': { img: 'image', prompt: true, extra: { duration: 5 } },
  'minimax/hailuo-02': { img: 'first_frame_image', prompt: true, extra: { duration: 6 } },
  'kwaivgi/kling-v2.1': { img: 'start_image', prompt: true, extra: { duration: 5 } },
  'kwaivgi/kling-v1.6-pro': { img: 'start_image', prompt: true, extra: { duration: 5 } },
  // spares used to replace models that failed / hung
  'leonardoai/motion-2.0': { img: 'image', prompt: true },
  'google/veo-2': { img: 'image', prompt: true },
  'wan-video/wan-2.2-i2v-a14b': { img: 'image', prompt: true },
};

// card -> [model, optional set code to pin a specific printing's art].
const ASSIGN = [
  ['Ancestral Recall', 'bytedance/seedance-1-lite', '2ed'],
  ['Demonic Tutor', 'pixverse/pixverse-v4.5'],
  ['Force of Will', 'bytedance/seedance-1-lite', 'all'],
  ['Wrath of God', 'bytedance/seedance-1-lite', 'dmr'],
  ['Birds of Paradise', 'minimax/video-01-live'],
  ['Counterspell', 'leonardoai/motion-2.0'],
  ['Lightning Bolt', 'bytedance/seedance-1-lite', 'clu'],
  ['Vampiric Tutor', 'bytedance/seedance-1-lite', 'vis'],
  ['Dark Ritual', 'bytedance/seedance-1-lite', 'me4'],
  ['Serra Angel', 'bytedance/seedance-1-lite', '4ed'],
  ['Emrakul, the Aeons Torn', 'bytedance/seedance-1-lite', 'uma'],
  ['Wolf Pack', 'bytedance/seedance-1-lite'],
  ['Vorinclex, Monstrous Raider', 'bytedance/seedance-1-pro'],
  ['Niv-Mizzet, Parun', 'minimax/hailuo-02'],
  ['Ulamog, the Ceaseless Hunger', 'bytedance/seedance-1-lite', 'cmm'],
  ['Garruk, Cursed Huntsman', 'bytedance/seedance-1-lite', 'eld'],
  ['Chandra Ablaze', 'bytedance/seedance-1-lite'],
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

async function fetchCard(name, set) {
  const params = { exact: name };
  if (set) params.set = set; // pin a specific printing's art
  const res = await fetch('https://api.scryfall.com/cards/named?' + new URLSearchParams(params), {
    headers: { 'User-Agent': 'MTGArtistIndex/0.1 (bake-off)', Accept: 'application/json' }, // Scryfall 400s without a UA
  });
  if (!res.ok) throw new Error(`scryfall ${name}${set ? ` (${set})` : ''}: HTTP ${res.status}`);
  const j = await res.json();
  const image = j.image_uris?.normal ?? j.card_faces?.[0]?.image_uris?.normal;
  const oracle = j.oracle_text ?? (j.card_faces?.map((f) => f.oracle_text).filter(Boolean).join(' // ')) ?? '';
  return { name: j.name, image, oracle, set: (j.set || '').toUpperCase(), setName: j.set_name || '' };
}

const buildPrompt = (card) =>
  `${card.name}. ${card.oracle} Animate this Magic: The Gathering illustration with subtle, faithful cinematic motion; keep the original composition and characters intact.`;

async function loadManifest() {
  if (!existsSync(MANIFEST)) return [];
  try {
    return JSON.parse(await readFile(MANIFEST, 'utf8'));
  } catch {
    return [];
  }
}

// Resolve a model's latest version id. Version-pinned predictions work for
// BOTH official and community models; the /models/{id}/predictions shortcut
// only works for official ones (community models 404 it).
const versionCache = new Map();
async function getVersion(token, modelId) {
  if (versionCache.has(modelId)) return versionCache.get(modelId);
  const res = await fetch(`https://api.replicate.com/v1/models/${modelId}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`model ${modelId}: HTTP ${res.status}`);
  const j = await res.json();
  const v = j.latest_version?.id;
  if (!v) throw new Error(`model ${modelId}: no latest_version`);
  versionCache.set(modelId, v);
  return v;
}

/** POST a prediction by version, honoring 429 backoff. Returns {ok,status,json,text}. */
async function postCreate(token, version, input) {
  for (let i = 0; i < 8; i++) {
    const res = await fetch('https://api.replicate.com/v1/predictions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ version, input }),
    });
    if (res.status === 429) {
      const b = await res.json().catch(() => ({}));
      const w = ((b.retry_after ?? 10) + 1) * 1000;
      process.stdout.write(`(429 ${Math.ceil(w / 1000)}s)`);
      await sleep(w);
      continue;
    }
    if (res.status === 402) throw new Error('402 insufficient credit — top up at replicate.com/account/billing');
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { ok: res.ok, status: res.status, json, text };
  }
  return { ok: false, status: 429, text: 'rate-limited after retries' };
}

/** Try richest input first, fall back to simpler input on 4xx input rejections. */
async function createPrediction(token, modelId, m, image, prompt) {
  const base = { [m.img]: image };
  const withPrompt = m.prompt && prompt ? { ...base, prompt } : { ...base };
  const attempts = [];
  if (m.extra) attempts.push({ ...withPrompt, ...m.extra });
  attempts.push(withPrompt);
  if (m.prompt && prompt) attempts.push({ ...base, prompt: 'Subtle, faithful cinematic motion bringing the artwork to life.' });
  attempts.push(base);

  const version = await getVersion(token, modelId);
  let last;
  for (const input of attempts) {
    const r = await postCreate(token, version, input);
    if (r.ok) return r.json;
    last = r;
    if (r.status !== 422 && r.status !== 400) throw new Error(`HTTP ${r.status} ${(r.text || '').slice(0, 200)}`);
  }
  throw new Error(`all inputs rejected (${last.status}) ${(last.text || '').slice(0, 200)}`);
}

async function poll(token, pred) {
  let p = pred;
  const deadline = Date.now() + 8 * 60 * 1000; // a stuck prediction must not hang the whole run
  while (!['succeeded', 'failed', 'canceled'].includes(p.status)) {
    if (Date.now() > deadline) {
      try { if (p.urls?.cancel) await fetch(p.urls.cancel, { method: 'POST', headers: { Authorization: `Bearer ${token}` } }); } catch {}
      throw new Error('poll timeout (>8m, canceled)');
    }
    await sleep(4000);
    const r = await fetch(p.urls.get, { headers: { Authorization: `Bearer ${token}` } });
    p = await r.json();
    process.stdout.write('.');
  }
  process.stdout.write('\n');
  if (p.status !== 'succeeded') throw new Error(`prediction ${p.status}: ${p.error ?? ''}`);
  return p.output;
}

function extractVideoUrl(out) {
  if (!out) return null;
  if (typeof out === 'string') return out;
  if (Array.isArray(out)) return extractVideoUrl(out[0]);
  if (typeof out === 'object') return out.video ?? out.url ?? out.output ?? Object.values(out).find((v) => typeof v === 'string') ?? null;
  return null;
}

async function download(url, dest) {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`download: HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const manifest = await loadManifest();
  const byCard = new Map(manifest.map((e) => [e.card, e]));

  console.log(`Bake-off: ${ASSIGN.length} cards x distinct models`);
  if (dryRun) {
    for (const [card, model, set] of ASSIGN) {
      const done = byCard.has(card) && existsSync(join(CLIP_DIR, `${slug(card)}.mp4`));
      console.log(`  ${done ? '✓ done   ' : '· pending'} ${card}${set ? ` [${set}]` : ''} → ${model}`);
    }
    return;
  }

  const token = process.env.REPLICATE_API_TOKEN;
  if (!token) throw new Error('REPLICATE_API_TOKEN not set');
  await mkdir(CLIP_DIR, { recursive: true });

  let done = 0;
  for (const [card, modelId, set] of ASSIGN) {
    const m = MODELS[modelId];
    const clipFile = `${slug(card)}.mp4`; // keyed by card now (cards can share a model)
    if (byCard.has(card) && existsSync(join(CLIP_DIR, clipFile))) {
      console.log(`✓ skip ${card} (${modelId})`);
      done++;
      continue;
    }
    try {
      console.log(`[${done + 1}/${ASSIGN.length}] ${card}${set ? ` [${set}]` : ''} → ${modelId}`);
      const cardData = await fetchCard(card, set);
      if (!cardData.image) throw new Error('no card image');
      const prompt = m.prompt ? buildPrompt(cardData) : null;
      const pred = await createPrediction(token, modelId, m, cardData.image, prompt);
      const url = extractVideoUrl(await poll(token, pred));
      if (!url) throw new Error('no video URL in output');
      await download(url, join(CLIP_DIR, clipFile));
      const entry = { card: cardData.name, set: cardData.setName, model: modelId, clip: `/data/bakeoff/${clipFile}`, image: cardData.image, usedText: Boolean(prompt) };
      byCard.set(card, entry);
      // keep manifest in the curated card order
      const ordered = ASSIGN.map(([c]) => byCard.get(c)).filter(Boolean);
      await writeFile(MANIFEST, JSON.stringify(ordered, null, 2) + '\n');
      done++;
    } catch (e) {
      console.warn(`  ✗ ${card} (${modelId}): ${e.message}`);
      if (/402/.test(e.message)) { console.error('Stopping: out of credit.'); break; }
    }
  }
  console.log(`\nDone: ${done}/${ASSIGN.length} clips → public/data/bakeoff/, manifest → src/data/bakeoff.json`);
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
