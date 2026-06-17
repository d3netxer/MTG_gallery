import { describe, it, expect } from 'vitest';
import { roomArtworks, type RoomArtSource, type CardLike } from './room-art';

function src(
  cards: Record<string, CardLike>,
  artists: Record<string, string[]>,
  slugs: Record<string, string>
): RoomArtSource {
  return {
    cardByIllo: new Map(Object.entries(cards)),
    artistsByIllo: new Map(Object.entries(artists)),
    slugOf: new Map(Object.entries(slugs)),
  };
}

const card = (name: string, year: number, extra: Partial<CardLike> = {}): CardLike => ({
  name,
  year,
  setCode: 'TST',
  image: `https://img/${name}.jpg`,
  ...extra,
});

describe('roomArtworks', () => {
  it('joins illustration_ids to card art and artist slugs', () => {
    const s = src(
      { i1: card('Llanowar Elves', 1993) },
      { i1: ['Anson Maddocks'] },
      { 'Anson Maddocks': 'anson-maddocks' }
    );
    const [art] = roomArtworks(['i1'], s);
    expect(art).toEqual({
      image: 'https://img/Llanowar Elves.jpg',
      name: 'Llanowar Elves',
      setCode: 'TST',
      year: 1993,
      artists: [{ name: 'Anson Maddocks', slug: 'anson-maddocks' }],
    });
  });

  it('sorts newest first, then by name', () => {
    const s = src(
      { a: card('Zndrsplt', 2019), b: card('Aboroth', 2019), c: card('Old One', 1995) },
      {},
      {}
    );
    expect(roomArtworks(['c', 'a', 'b'], s).map((x) => x.name)).toEqual(['Aboroth', 'Zndrsplt', 'Old One']);
  });

  it('skips illustration_ids with no card or no image', () => {
    const s = src(
      { ok: card('Real', 2000), noImg: card('Imageless', 2000, { image: '' }) },
      {},
      {}
    );
    expect(roomArtworks(['ok', 'noImg', 'missing'], s).map((x) => x.name)).toEqual(['Real']);
  });

  it('keeps multiple collaborators but dedupes a repeated slug', () => {
    const s = src(
      { i1: card('Collab', 2010) },
      { i1: ['Rob Alexander', 'Terese Nielsen', 'Rob Alexander'] },
      { 'Rob Alexander': 'rob-alexander', 'Terese Nielsen': 'terese-nielsen' }
    );
    expect(roomArtworks(['i1'], s)[0].artists).toEqual([
      { name: 'Rob Alexander', slug: 'rob-alexander' },
      { name: 'Terese Nielsen', slug: 'terese-nielsen' },
    ]);
  });

  it('drops artist names that have no slug, leaving the artwork', () => {
    const s = src({ i1: card('Orphan Art', 2005) }, { i1: ['Nobody Known'] }, {});
    const [art] = roomArtworks(['i1'], s);
    expect(art.name).toBe('Orphan Art');
    expect(art.artists).toEqual([]);
  });
});
