import { describe, it, expect } from 'vitest';
import { ancestorsOf, deriveRooms, type TagNode } from './rooms';

// Graph:
//   dragon-red --parent--> dragons --parent--> creatures
//   loner (no parents)
//   cycle: x <-> y  (x parent y, y parent x)
const graph = new Map<string, TagNode>([
  ['t-dragon-red', { id: 't-dragon-red', slug: 'dragon-red', label: 'Red Dragon', parentIds: ['t-dragons'] }],
  ['t-dragons', { id: 't-dragons', slug: 'dragons', label: 'Dragons', parentIds: ['t-creatures'] }],
  ['t-creatures', { id: 't-creatures', slug: 'creatures', label: 'Creatures', parentIds: [] }],
  ['t-loner', { id: 't-loner', slug: 'loner', label: 'Loner', parentIds: [] }],
  ['t-x', { id: 't-x', slug: 'x', label: 'X', parentIds: ['t-y'] }],
  ['t-y', { id: 't-y', slug: 'y', label: 'Y', parentIds: ['t-x'] }],
]);

describe('ancestorsOf', () => {
  it('returns the transitive parent closure', () => {
    expect([...ancestorsOf('t-dragon-red', graph)].sort()).toEqual(['t-creatures', 't-dragons']);
  });
  it('survives cycles without looping forever (self excluded)', () => {
    // x -> y -> x; y is x's ancestor, but x is not its own ancestor (self-edge guarded)
    expect([...ancestorsOf('t-x', graph)].sort()).toEqual(['t-y']);
  });
  it('skips unknown parent ids', () => {
    const g = new Map<string, TagNode>([['a', { id: 'a', slug: 'a', label: 'A', parentIds: ['missing'] }]]);
    expect([...ancestorsOf('a', g)]).toEqual(['missing']); // recorded, not expanded, no throw
  });
});

describe('deriveRooms', () => {
  const members = new Map<string, Set<string>>([
    ['t-dragon-red', new Set(['i1', 'i2'])],
    ['t-dragons', new Set(['i2', 'i3'])], // i2 shared with dragon-red
    ['t-loner', new Set(['i4'])],
  ]);

  it('rolls leaf artworks up into ancestor rooms', () => {
    const { rooms } = deriveRooms(graph, members, { minCount: 1 });
    expect([...rooms.get('dragons')!.members].sort()).toEqual(['i1', 'i2', 'i3']);
    expect([...rooms.get('creatures')!.members].sort()).toEqual(['i1', 'i2', 'i3']);
  });

  it('de-dups shared artworks (i2 counted once in dragons)', () => {
    const { rooms } = deriveRooms(graph, members, { minCount: 1 });
    expect(rooms.get('dragons')!.members.size).toBe(3);
  });

  it('applies the min-count threshold', () => {
    const { rooms } = deriveRooms(graph, members, { minCount: 3 });
    expect(rooms.has('dragons')).toBe(true); // 3 members
    expect(rooms.has('creatures')).toBe(true); // 3 members
    expect(rooms.has('dragon-red')).toBe(false); // only 2
    expect(rooms.has('loner')).toBe(false); // only 1
  });

  it('sorts candidates by count descending', () => {
    const { candidates } = deriveRooms(graph, members, { minCount: 1 });
    const counts = candidates.map((c) => c.count);
    expect(counts).toEqual([...counts].sort((a, b) => b - a));
  });

  it('maxCount and stoplist exclude rooms from candidates but keep them in the rooms map', () => {
    const { rooms, candidates } = deriveRooms(graph, members, {
      minCount: 1,
      maxCount: 2, // excludes dragons(3) + creatures(3) from candidates
      stoplist: new Set(['loner']),
    });
    const slugs = candidates.map((c) => c.slug);
    expect(slugs).not.toContain('dragons'); // over maxCount
    expect(slugs).not.toContain('loner'); // stoplisted
    expect(slugs).toContain('dragon-red'); // 2 members, allowed
    // full map still has them so a pinned manifest room resolves members
    expect(rooms.has('dragons')).toBe(true);
    expect(rooms.has('loner')).toBe(true);
  });

  it('does not loop or throw on cyclic membership', () => {
    const cyc = new Map([['t-x', new Set(['i9'])]]);
    const { rooms } = deriveRooms(graph, cyc, { minCount: 1 });
    expect(rooms.get('x')!.members.has('i9')).toBe(true);
    expect(rooms.get('y')!.members.has('i9')).toBe(true);
  });
});
