# TODOS — MTG Artist Index

## ✅ Curation data-quality report — DONE
- **Shipped:** `src/lib/curation.ts` (pure, tested in `curation.test.ts`) + wiring in `build-data.ts`. Each `npm run build:data` now writes an advisory `curation-report.md` (gitignored) and logs a one-line summary.
- **Detects:**
  - Suspected artist-name variants — nickname/short-form (`Dave`/`David`, table-based `Bob`/`Robert`), initial-vs-full (`J. Schirmer`/`Jana Schirmer`), and spelling/accent/ß variants that do *not* already collide on slug (e.g. `Voß`/`Voss`). Spelling pairs that DO collide are dropped — the hard slug-collision detector already owns those, so the report stays strictly complementary.
  - Orphan curated entries — `curated-artists.json` `scryfallName`s that matched no artist in the build (typo or artist absent from Scryfall).
- **Advisory only:** never fails the build; it's a worklist for a human. Homonyms and intentionally separate credits are expected false positives.

## Possible follow-ups
- The slug-collision warning surfaces Scryfall artist names carrying a trailing `(age NN)` token (e.g. `Lars Grant-West` → `lars-grant-west-age-52`). Worth investigating whether to strip that token at ingest or canonicalize via `curated-artists.json`.
