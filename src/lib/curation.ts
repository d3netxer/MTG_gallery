// Curation data-quality report (TODOS.md).
//
// The hard slug-collision detector in build-data.ts FAILS-loud when two
// distinct artists normalize to the same route. This module is the softer,
// ADVISORY layer on top: it surfaces *likely* curation work that no
// deterministic rule can decide on its own —
//   - artist-name variants that should probably collapse to one canonical
//     name ("Chris Rush" vs "Christopher Rush", "Johannes Voß" vs "Voss",
//     "S. Makimura" vs a fuller spelling), and
//   - curated-artists.json entries whose scryfallName matched no artist
//     in the build (a typo, or an artist absent from Scryfall).
//
// Everything here is a *candidate*. Homonyms (two real people sharing a name)
// and intentionally separate credits are expected false positives — the report
// is a worklist for a human, never a build gate.

import { toSlug } from './slug.ts';

export type VariantKind = 'spelling' | 'nickname' | 'initial';

export interface NameVariant {
  kind: VariantKind;
  /** The two display names, sorted, that look like the same artist. */
  names: [string, string];
  /** Human explanation of why they were paired. */
  detail: string;
}

export interface OrphanCollection {
  scryfallName: string;
  collections: string[];
}

/** Minimal shape of a curated-artists.json entry this module reads. */
export interface CuratedLike {
  scryfallName: string;
  openSeaCollections?: string[];
}

// Common English given-name short forms. Two names sharing a last name whose
// first names fall in the same group are flagged as nickname candidates. The
// prefix rule below catches unlisted pairs ("Cam"/"Cameron"); this table
// catches the ones a prefix can't ("Bob"/"Robert", "Bill"/"William").
const NICK_GROUPS: string[][] = [
  ['chris', 'christopher', 'christian'],
  ['mike', 'michael'],
  ['matt', 'matthew'],
  ['dan', 'daniel', 'danny'],
  ['dave', 'david'],
  ['jon', 'jonathan', 'john', 'johnny'],
  ['tom', 'thomas', 'tommy'],
  ['rob', 'robert', 'bob', 'bobby'],
  ['steve', 'steven', 'stephen'],
  ['nick', 'nicholas'],
  ['ben', 'benjamin', 'benji'],
  ['sam', 'samuel'],
  ['joe', 'joseph', 'joey'],
  ['jim', 'james', 'jimmy'],
  ['will', 'william', 'bill', 'billy'],
  ['greg', 'gregory'],
  ['andy', 'andrew', 'drew'],
  ['ed', 'edward', 'eddie'],
  ['tony', 'anthony'],
  ['pat', 'patrick'],
  ['ron', 'ronald'],
  ['rick', 'richard', 'rich', 'dick'],
  ['alex', 'alexander'],
  ['nate', 'nathan', 'nathaniel'],
  ['gabe', 'gabriel'],
  ['zach', 'zachary'],
  ['josh', 'joshua'],
  ['ken', 'kenneth', 'kenny'],
  ['ray', 'raymond'],
];
const NICK_OF = new Map<string, number>();
NICK_GROUPS.forEach((group, i) => group.forEach((n) => NICK_OF.set(n, i)));

/** Strip accents (and the German ß, which NFKD leaves intact) for matching. */
function deaccent(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ß/g, 'ss');
}

/** Lower-cased alphanumeric tokens, e.g. "S. Grant-West" -> ["s", "grantwest"]. */
function tokens(name: string): string[] {
  return deaccent(name)
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.replace(/[^a-z0-9]/g, ''))
    .filter(Boolean);
}

/** Whole name reduced to bare alphanumerics, ignoring case/accents/punctuation. */
function looseKey(name: string): string {
  return deaccent(name).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function firstNameRelation(a: string, b: string): { kind: VariantKind; detail: string } | null {
  // Initial vs. full first name: "S." paired with "Sawaki".
  if (a.length === 1 || b.length === 1) {
    const [init, full] = a.length === 1 ? [a, b] : [b, a];
    if (full.length > 1 && full[0] === init[0]) return { kind: 'initial', detail: `initial "${init}." vs "${full}"` };
    return null;
  }
  const ga = NICK_OF.get(a);
  const gb = NICK_OF.get(b);
  if (ga !== undefined && ga === gb) return { kind: 'nickname', detail: `"${a}" and "${b}" are common short-forms of one name` };
  // Diminutive by prefix: "Cam" ⊂ "Cameron". Min length 3 avoids initials-ish noise.
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (short.length >= 3 && long.length > short.length && long.startsWith(short)) {
    return { kind: 'nickname', detail: `"${short}" is a prefix of "${long}"` };
  }
  return null;
}

/**
 * Find pairs of artist names that look like the same person. Strictly
 * COMPLEMENTARY to the hard slug-collision detector: spelling variants that
 * already collide on slug are dropped (that detector already flags them).
 */
export function findNameVariants(names: string[]): NameVariant[] {
  const out: NameVariant[] = [];

  // 1) Spelling / accent / punctuation: identical loose key, but DIFFERENT
  //    slugs (same-slug groups are already a hard collision elsewhere).
  const byLoose = new Map<string, string[]>();
  for (const n of names) {
    const k = looseKey(n);
    if (!k) continue;
    let g = byLoose.get(k);
    if (!g) byLoose.set(k, (g = []));
    g.push(n);
  }
  for (const group of byLoose.values()) {
    if (group.length < 2) continue;
    if (new Set(group.map(toSlug)).size < 2) continue; // already a hard collision
    const sorted = [...group].sort((a, b) => a.localeCompare(b));
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        out.push({ kind: 'spelling', names: [sorted[i], sorted[j]], detail: 'same name ignoring accents/punctuation, but different slug' });
      }
    }
  }

  // 2) Same last name, related first name (nickname / initial).
  const byLast = new Map<string, { name: string; first: string }[]>();
  for (const n of names) {
    const t = tokens(n);
    if (t.length < 2) continue; // skip mononyms — nothing to pair on
    const last = t[t.length - 1];
    let bucket = byLast.get(last);
    if (!bucket) byLast.set(last, (bucket = []));
    bucket.push({ name: n, first: t[0] });
  }
  for (const bucket of byLast.values()) {
    if (bucket.length < 2) continue;
    bucket.sort((a, b) => a.name.localeCompare(b.name));
    for (let i = 0; i < bucket.length; i++) {
      for (let j = i + 1; j < bucket.length; j++) {
        if (bucket[i].first === bucket[j].first) continue; // identical first -> handled by (1) or truly same
        const rel = firstNameRelation(bucket[i].first, bucket[j].first);
        if (rel) out.push({ kind: rel.kind, names: [bucket[i].name, bucket[j].name], detail: rel.detail });
      }
    }
  }

  return out;
}

/** Curated entries whose scryfallName never matched a card in the build. */
export function findOrphanCollections(curated: CuratedLike[], seenNames: Set<string>): OrphanCollection[] {
  return curated
    .filter((c) => !seenNames.has(c.scryfallName))
    .map((c) => ({ scryfallName: c.scryfallName, collections: c.openSeaCollections ?? [] }))
    .sort((a, b) => a.scryfallName.localeCompare(b.scryfallName));
}

const VARIANT_SECTIONS: [VariantKind, string][] = [
  ['spelling', 'Spelling / accent / punctuation variants'],
  ['nickname', 'Nickname / short-form variants'],
  ['initial', 'Initial vs. full first name'],
];

/** Render the report as Markdown. `generatedAt` should be a stable date string. */
export function formatCurationReport(variants: NameVariant[], orphans: OrphanCollection[], generatedAt: string): string {
  const lines: string[] = [
    '# Curation data-quality report',
    '',
    `_Generated ${generatedAt} by \`npm run build:data\`. Advisory only — nothing here fails the build._`,
    '',
    'Each item is a *candidate* for a `curated-artists.json` entry (name canonicalization or a corrected `scryfallName`). Homonyms and intentionally separate credits are expected false positives — confirm before acting.',
    '',
    `## Suspected artist-name variants (${variants.length})`,
    '',
  ];
  if (variants.length) {
    for (const [kind, title] of VARIANT_SECTIONS) {
      const items = variants.filter((v) => v.kind === kind);
      if (!items.length) continue;
      lines.push(`### ${title} (${items.length})`, '');
      for (const v of items) lines.push(`- \`${v.names[0]}\`  ⇄  \`${v.names[1]}\` — ${v.detail}`);
      lines.push('');
    }
  } else {
    lines.push('_None detected._', '');
  }

  lines.push(`## Orphan OpenSea collections (${orphans.length})`, '');
  if (orphans.length) {
    lines.push('Curated entries whose `scryfallName` matched no artist in this build (typo, or artist absent from Scryfall):', '');
    for (const o of orphans) {
      const cols = o.collections.length ? o.collections.map((c) => `\`${c}\``).join(', ') : '_(no collections)_';
      lines.push(`- \`${o.scryfallName}\` → ${cols}`);
    }
  } else {
    lines.push('_None — every curated entry matched an artist._');
  }
  lines.push('');
  return lines.join('\n');
}
