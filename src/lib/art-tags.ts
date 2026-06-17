// Art-tag ingestion core (eng-review T1).
//
// Scryfall's `art_tags` bulk is a list of TAG objects, each with a `taggings`
// array pointing at illustration_ids (tag -> artworks). To show tags on an
// artwork we INVERT to illustration_id -> [tags]. We also:
//   - drop weak taggings (weight below `strong`), and
//   - drop ORPHAN taggings whose illustration_id isn't in unique_artwork
//     (art_tags covers the full card corpus, not the deduped set).
//
// This module is pure and unit-tested. build-data.ts feeds tags through
// `applyTag` one at a time while streaming, so the 40 MB file is never held
// in memory all at once.

export const WEIGHT_RANK: Record<string, number> = {
  very_strong: 3,
  strong: 2,
  median: 1,
};

/** Minimum weight to keep a tagging. `strong` and up; drops `median`. */
export const MIN_WEIGHT_RANK = 2;

export interface RawTagging {
  illustration_id: string;
  weight: string;
}

/** Shared predicate: is this tagging strong enough AND a real artwork? */
export function taggingKept(
  t: RawTagging,
  validIllustrationIds: Set<string>,
  minWeightRank: number = MIN_WEIGHT_RANK
): boolean {
  return (WEIGHT_RANK[t.weight] ?? 0) >= minWeightRank && validIllustrationIds.has(t.illustration_id);
}

export interface RawArtTag {
  label: string;
  slug: string;
  type?: string;
  parent_ids?: string[];
  child_ids?: string[];
  taggings?: RawTagging[];
}

export interface ArtworkTag {
  slug: string;
  label: string;
  weight: string;
}

export interface TagStats {
  tags: number; // tag objects seen
  taggings: number; // total taggings seen
  kept: number; // taggings kept (strong+, valid illo, not a dup)
  belowWeight: number; // taggings dropped for weak weight
  orphan: number; // taggings dropped: illustration_id not in unique_artwork
  illustrationsTagged: number; // distinct illustrations with >=1 kept tag
}

export function emptyStats(): TagStats {
  return { tags: 0, taggings: 0, kept: 0, belowWeight: 0, orphan: 0, illustrationsTagged: 0 };
}

/**
 * Fold one art-tag's taggings into the inverted map. Skips weak weights and
 * orphan illustration_ids; de-dups a tag so it appears at most once per
 * illustration. Mutates `byIllustration` and `stats`.
 */
export function applyTag(
  tag: RawArtTag,
  validIllustrationIds: Set<string>,
  byIllustration: Map<string, ArtworkTag[]>,
  stats: TagStats,
  minWeightRank: number = MIN_WEIGHT_RANK
): void {
  stats.tags++;
  if (!tag.taggings) return;
  for (const t of tag.taggings) {
    stats.taggings++;
    if ((WEIGHT_RANK[t.weight] ?? 0) < minWeightRank) {
      stats.belowWeight++;
      continue;
    }
    if (!validIllustrationIds.has(t.illustration_id)) {
      stats.orphan++;
      continue;
    }
    let list = byIllustration.get(t.illustration_id);
    if (!list) byIllustration.set(t.illustration_id, (list = []));
    if (list.some((x) => x.slug === tag.slug)) continue; // de-dup per illustration
    list.push({ slug: tag.slug, label: tag.label, weight: t.weight });
    stats.kept++;
  }
}

/** Sort each illustration's tags strongest-first and finalize counts. */
export function finalize(byIllustration: Map<string, ArtworkTag[]>, stats: TagStats): void {
  for (const list of byIllustration.values()) {
    list.sort(
      (a, b) => (WEIGHT_RANK[b.weight] ?? 0) - (WEIGHT_RANK[a.weight] ?? 0) || a.slug.localeCompare(b.slug)
    );
  }
  stats.illustrationsTagged = byIllustration.size;
}

/** Pure batch form (used by tests). */
export function invertTaggings(
  tags: RawArtTag[],
  validIllustrationIds: Set<string>,
  minWeightRank: number = MIN_WEIGHT_RANK
): { byIllustration: Map<string, ArtworkTag[]>; stats: TagStats } {
  const byIllustration = new Map<string, ArtworkTag[]>();
  const stats = emptyStats();
  for (const tag of tags) applyTag(tag, validIllustrationIds, byIllustration, stats, minWeightRank);
  finalize(byIllustration, stats);
  return { byIllustration, stats };
}
