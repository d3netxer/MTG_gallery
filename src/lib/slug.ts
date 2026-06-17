// Shared slug module (eng-review T3).
// ONE source of truth for artist -> slug, used by the data build, the page
// routes, and (later) the /api/nft-prices lookup. A drifted slug is a silent
// failure, so build, page, and API must all import this exact function.

/** Small deterministic hash → base36, for slug fallbacks. */
function hash36(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

/** Convert an artist display name into a URL-safe kebab-case slug. */
export function toSlug(name: string): string {
  const kebab = name
    .normalize('NFKD') // split accented chars: "Voß" -> "Voß", "é" -> "e´"
    .replace(/[̀-ͯ]/g, '') // strip combining diacritics
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-') // non-alphanumerics -> hyphen
    .replace(/^-+|-+$/g, '') // trim leading/trailing hyphens
    .replace(/-{2,}/g, '-'); // collapse runs
  // Names with no latin characters (e.g. CJK) would otherwise yield "" and
  // collide. Fall back to a deterministic token so the route is always valid.
  // These are prime candidates for a curated-artists.json canonical name.
  return kebab || `artist-${hash36(name)}`;
}

/**
 * Assign slugs across a set of artist names, appending -2, -3, ... on
 * collision so two distinct artists never share a route. Deterministic:
 * input order in, stable slugs out. Build callers should treat a collision
 * as a signal to add a curated-artists.json entry (see TODOS.md).
 */
export function assignSlugs(names: string[]): Map<string, string> {
  const used = new Map<string, number>();
  const out = new Map<string, string>();
  for (const name of names) {
    const base = toSlug(name);
    const count = used.get(base) ?? 0;
    used.set(base, count + 1);
    out.set(name, count === 0 ? base : `${base}-${count + 1}`);
  }
  return out;
}
