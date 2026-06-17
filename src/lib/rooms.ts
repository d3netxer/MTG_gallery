// Room derivation (eng-review T2).
//
// Art tags form a DAG: a granular tag ("axgard") rolls up via `parent_ids`
// to broader concepts ("kaldheim" -> "planes"). A "room" is a tag whose
// rolled-up membership (its own strongly-tagged artworks plus those of every
// descendant) clears a minimum count.
//
// Membership is a Set<illustration_id>, so an artwork reachable through two
// paths into the same room counts once — this is what makes the rollup safe
// without a separate "canonical parent" rule. Cross-room overlap (a piece in
// both "Dragons" and "Zendikar") is intentional.
//
// Derivation only PROPOSES candidates. The committed rooms.json manifest is
// the URL contract (see build-data.ts): refreshes update counts inside rooms
// but never silently delete a published room.

export interface TagNode {
  id: string;
  slug: string;
  label: string;
  parentIds: string[];
}

export interface RoomCandidate {
  slug: string;
  label: string;
  count: number;
}

export interface Room {
  slug: string;
  label: string;
  members: Set<string>; // illustration_ids
}

/**
 * Transitive parent closure of a tag, cycle-guarded. Iterative + a visited
 * set (the `result`) so a cycle in parent_ids can't loop forever. Unknown
 * parent ids (parents not present in this bulk) are simply skipped.
 */
export function ancestorsOf(id: string, graph: Map<string, TagNode>): Set<string> {
  const result = new Set<string>();
  const stack = [...(graph.get(id)?.parentIds ?? [])];
  while (stack.length) {
    const p = stack.pop()!;
    if (p === id || result.has(p)) continue; // skip self-edge + already-seen (cycle guard)
    result.add(p);
    const pn = graph.get(p);
    if (pn) for (const gp of pn.parentIds) if (!result.has(gp)) stack.push(gp);
  }
  return result;
}

/**
 * Roll tag memberships up the DAG and keep tags whose rolled-up membership
 * meets `minCount`. Returns rooms keyed by slug plus a count-sorted candidate
 * list.
 */
export function deriveRooms(
  graph: Map<string, TagNode>,
  members: Map<string, Set<string>>, // tagId -> directly (strongly) tagged illustration_ids
  opts: { minCount: number; maxCount?: number; stoplist?: Set<string> }
): { rooms: Map<string, Room>; candidates: RoomCandidate[] } {
  const roomMembers = new Map<string, Set<string>>(); // tagId -> rolled-up illustration set

  for (const [tagId, direct] of members) {
    const targets = ancestorsOf(tagId, graph);
    targets.add(tagId); // a tag is a room for its own artworks too
    for (const target of targets) {
      let set = roomMembers.get(target);
      if (!set) roomMembers.set(target, (set = new Set()));
      for (const illo of direct) set.add(illo);
    }
  }

  const rooms = new Map<string, Room>();
  const candidates: RoomCandidate[] = [];
  for (const [tagId, set] of roomMembers) {
    if (set.size < opts.minCount) continue;
    const node = graph.get(tagId);
    if (!node) continue; // membership for a tag we have no node for — skip
    // slug collision across tag ids: keep the larger room
    const existing = rooms.get(node.slug);
    if (existing && existing.members.size >= set.size) continue;
    rooms.set(node.slug, { slug: node.slug, label: node.label, members: set });
  }
  // Candidates are what bootstrap/suggestions surface. We filter out rooms that
  // make poor museum halls: over-broad roots (count > maxCount, e.g. "character")
  // and demographic/structural tags (stoplist, e.g. "human"). The full `rooms`
  // map is left intact so a manifest that deliberately PINS such a room can
  // still resolve its members.
  for (const room of rooms.values()) {
    if (opts.maxCount !== undefined && room.members.size > opts.maxCount) continue;
    if (opts.stoplist?.has(room.slug)) continue;
    candidates.push({ slug: room.slug, label: room.label, count: room.members.size });
  }
  candidates.sort((a, b) => b.count - a.count || a.slug.localeCompare(b.slug));
  return { rooms, candidates };
}
