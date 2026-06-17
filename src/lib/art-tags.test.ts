import { describe, it, expect } from 'vitest';
import { invertTaggings, applyTag, emptyStats, type RawArtTag } from './art-tags';

const valid = new Set(['illoA', 'illoB']); // 'illoC' is intentionally NOT in unique_artwork

const tags: RawArtTag[] = [
  {
    label: 'Dragon',
    slug: 'dragon',
    taggings: [
      { illustration_id: 'illoA', weight: 'very_strong' },
      { illustration_id: 'illoB', weight: 'median' }, // weak -> dropped
    ],
  },
  {
    label: 'Landscape',
    slug: 'landscape',
    taggings: [
      { illustration_id: 'illoA', weight: 'strong' },
      { illustration_id: 'illoC', weight: 'strong' }, // orphan -> dropped
    ],
  },
  {
    label: 'Dragon (dup)',
    slug: 'dragon', // same slug on illoA again -> de-duped
    taggings: [{ illustration_id: 'illoA', weight: 'strong' }],
  },
];

describe('invertTaggings', () => {
  const { byIllustration, stats } = invertTaggings(tags, valid);

  it('inverts tag->artworks into illustration->tags', () => {
    expect([...byIllustration.keys()]).toEqual(['illoA']);
  });

  it('drops median-weight taggings', () => {
    expect(byIllustration.has('illoB')).toBe(false);
    expect(stats.belowWeight).toBe(1);
  });

  it('drops orphan illustration_ids not in unique_artwork', () => {
    expect(byIllustration.has('illoC')).toBe(false);
    expect(stats.orphan).toBe(1);
  });

  it('de-dups a tag per illustration and sorts strongest-first', () => {
    expect(byIllustration.get('illoA')?.map((t) => t.slug)).toEqual(['dragon', 'landscape']);
    // dragon kept its strongest occurrence
    expect(byIllustration.get('illoA')?.[0].weight).toBe('very_strong');
  });

  it('reports honest stats', () => {
    expect(stats.tags).toBe(3);
    expect(stats.taggings).toBe(5);
    expect(stats.kept).toBe(2); // dragon + landscape on illoA
    expect(stats.illustrationsTagged).toBe(1);
  });
});

describe('applyTag (incremental, streaming form)', () => {
  it('accumulates across calls like the build pipeline does', () => {
    const map = new Map();
    const stats = emptyStats();
    for (const t of tags) applyTag(t, valid, map, stats);
    expect(stats.kept).toBe(2);
    expect(map.get('illoA')?.length).toBe(2);
  });

  it('honors a custom weight threshold (very_strong only)', () => {
    const map = new Map();
    const stats = emptyStats();
    applyTag(tags[0], valid, map, stats, 3); // require very_strong
    expect(map.get('illoA')?.length).toBe(1); // dragon very_strong kept
    expect(stats.kept).toBe(1);
  });
});
