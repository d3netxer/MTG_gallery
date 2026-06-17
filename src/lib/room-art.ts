// Room artwork assembly (rooms route).
//
// deriveRooms (rooms.ts) gives each room a Set<illustration_id>. The room
// PAGE needs displayable artworks: an art crop, the card name, and the
// artist(s) to link to. This joins a room's illustration_ids against the card
// data (cardByIllo) and the per-illustration artist credits (artistsByIllo),
// resolving each artist display name to its slug.
//
// Pure + deterministic so room pages bake identically across builds and the
// join is unit-testable without the 259 MB bulk.

export interface CardLike {
  name: string;
  setCode: string;
  year: number;
  image: string; // full card image (normal) — shown whole, not cropped
}

export interface RoomArtist {
  name: string;
  slug: string;
}

export interface RoomArtwork {
  image: string;
  name: string;
  setCode: string;
  year: number;
  artists: RoomArtist[]; // may be empty (artwork whose artist was filtered out)
}

export interface RoomArtSource {
  cardByIllo: Map<string, CardLike>;
  artistsByIllo: Map<string, string[]>; // illustration_id -> canonical artist names
  slugOf: Map<string, string>; // canonical artist name -> slug
}

/**
 * Resolve a room's illustration_ids into displayable, sorted artworks.
 * Illustrations with no card or no image (shouldn't happen post-join) are
 * skipped. Newest first, then by name, then first artist slug — stable across
 * builds so the static pages don't churn.
 */
export function roomArtworks(memberIllos: Iterable<string>, src: RoomArtSource): RoomArtwork[] {
  const out: RoomArtwork[] = [];
  for (const illo of memberIllos) {
    const card = src.cardByIllo.get(illo);
    if (!card || !card.image) continue;
    const seen = new Set<string>();
    const artists: RoomArtist[] = [];
    for (const name of src.artistsByIllo.get(illo) ?? []) {
      const slug = src.slugOf.get(name);
      if (!slug || seen.has(slug)) continue; // unknown name or collaboration dupe
      seen.add(slug);
      artists.push({ name, slug });
    }
    out.push({ image: card.image, name: card.name, setCode: card.setCode, year: card.year, artists });
  }
  out.sort(
    (a, b) =>
      b.year - a.year ||
      a.name.localeCompare(b.name) ||
      (a.artists[0]?.slug ?? '').localeCompare(b.artists[0]?.slug ?? '')
  );
  return out;
}
