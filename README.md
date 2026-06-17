# The Magic Gallery

A curated, full-screen "living gallery" of Magic: The Gathering art — animated. Card art is sourced from [Scryfall](https://scryfall.com), brought to motion with image-to-video models, and can be restyled by a free-text "vibe" with an image-edit model. Built as a static [Astro](https://astro.build) site.

> Unofficial fan project. Magic: The Gathering and all card art are © Wizards of the Coast. Non-commercial.

## What's here

- **`/`** — the living gallery: a wall of curated animated cards + a full-screen, auto-advancing reel (variable delay, click any card to start there).
- **`/browse`** — the full archive: every artist and theme, browsable by **theme** or **artist**.
- **`/rooms/[slug]`** / **`/rooms/artist/[slug]`** — theme and artist "rooms" (galleries grouped by art-tag or by artist), each with the full-screen gallery + a per-room "vibe" restyle.
- **`/bakeoff`** — a side-by-side comparison of image-to-video models, one clip per card, labeled with the model and printing used.

## Setup

```bash
npm install
cp .env.example .env      # then fill in keys (see below)
```

`.env` is gitignored — never commit real keys. Keys are only needed for the generation scripts:

- `REPLICATE_API_TOKEN` — image-to-video (`build:videos`, `build:bakeoff`) and image-edit (`build:vibe`).
- `OPENSEA_API_KEY` — live NFT listings (`build:nfts`), optional.

## Data is generated, not committed

To keep the repo lean, the card data is gitignored and regenerated from Scryfall's public bulk export. **Run this before building or running the dev server:**

```bash
npm run build:data        # streams Scryfall bulk -> src/data/* + public/data/overflow (no secrets)
```

The only generated assets committed to the repo are the **bake-off clips** (`public/data/bakeoff/`, `src/data/bakeoff.json`) — they're the living-gallery content and can't be regenerated in CI without a paid Replicate token.

## Develop & build

```bash
npm run dev               # local dev server (run build:data first)
npm run build             # static build -> dist/
npm run preview           # preview the production build
npm test                  # unit tests (vitest) for the data/lib modules
```

## Generation scripts (cost money / need a token)

```bash
# Animate room art into short clips (minimax/video-01)
npm run build:videos -- --room dragon --limit 5

# Restyle a room's art by a vibe, image-to-image (google/nano-banana)
npm run build:vibe -- --room planeswalker --vibe "neon cyberpunk" --limit 5

# Multi-model image-to-video bake-off over a curated card list
npm run build:bakeoff            # add --dry-run to preview cost first
```

All three are incremental (skip work already done), pace themselves against Replicate's rate limit, and write a manifest the site reads.

## Deploy (Netlify)

`netlify.toml` is committed, so Netlify picks up the settings automatically:

- **Build command:** `npm run build:data && npm run build`
- **Publish directory:** `dist`
- **Node:** 20

The first build downloads ~300 MB of Scryfall bulk (no CI cache), so it can take a few minutes.

## Tech notes

- Pure logic lives in `src/lib/*` with colocated `*.test.ts`; `scripts/build-data.ts` orchestrates the data pipeline.
- Rooms are derived from Scryfall's art-tag DAG; `rooms.json` is the committed URL contract for which rooms exist.
- The gallery component (`src/components/GalleryView.astro`) plays a per-card clip when one exists, prefers an active vibe restyle, and falls back to the still card otherwise.
