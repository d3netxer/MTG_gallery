import { describe, it, expect } from 'vitest';
import {
  findNameVariants,
  findOrphanCollections,
  formatCurationReport,
  type NameVariant,
} from './curation';

/** Find the variant pair (order-independent) flagged for two names, if any. */
function pairFor(variants: NameVariant[], a: string, b: string): NameVariant | undefined {
  return variants.find((v) => v.names.includes(a) && v.names.includes(b));
}

describe('findNameVariants', () => {
  it('flags nickname / short-form pairs sharing a last name', () => {
    const v = findNameVariants(['Chris Rush', 'Christopher Rush']);
    const hit = pairFor(v, 'Chris Rush', 'Christopher Rush');
    expect(hit?.kind).toBe('nickname');
  });

  it('flags table-based short forms a prefix would miss (Bob/Robert)', () => {
    const v = findNameVariants(['Bob Smith', 'Robert Smith']);
    expect(pairFor(v, 'Bob Smith', 'Robert Smith')?.kind).toBe('nickname');
  });

  it('flags an initial against a full first name', () => {
    const v = findNameVariants(['S. Makimura', 'Sawaki Makimura']);
    expect(pairFor(v, 'S. Makimura', 'Sawaki Makimura')?.kind).toBe('initial');
  });

  it('flags accent/ß spelling variants that do NOT collide on slug', () => {
    const v = findNameVariants(['Johannes Voß', 'Johannes Voss']);
    expect(pairFor(v, 'Johannes Voß', 'Johannes Voss')?.kind).toBe('spelling');
  });

  it('drops spelling variants that already collide on slug (hard detector owns those)', () => {
    // "José Pérez" and "Jose Perez" both slug to "jose-perez".
    expect(findNameVariants(['José Pérez', 'Jose Perez'])).toHaveLength(0);
  });

  it('does not pair distinct people with different last names', () => {
    expect(findNameVariants(['John Smith', 'Jane Doe'])).toHaveLength(0);
  });

  it('does not pair an initial whose letter does not match', () => {
    expect(findNameVariants(['S. Makimura', 'Takeyasu Makimura'])).toHaveLength(0);
  });

  it('ignores mononyms (nothing to pair on)', () => {
    expect(findNameVariants(['Ven', 'Villarrte', 'Wolfskulljack'])).toHaveLength(0);
  });

  it('is deterministic regardless of input order', () => {
    const a = findNameVariants(['Christopher Rush', 'Chris Rush']);
    const b = findNameVariants(['Chris Rush', 'Christopher Rush']);
    expect(a).toEqual(b);
    expect(a[0].names).toEqual(['Chris Rush', 'Christopher Rush']); // sorted within the pair
  });
});

describe('findOrphanCollections', () => {
  const curated = [
    { scryfallName: 'Seb McKinnon', openSeaCollections: ['seb-mckinnon'] },
    { scryfallName: 'Noah Bradlee', openSeaCollections: ['noah-bradley'] }, // typo'd name
  ];

  it('reports curated entries whose scryfallName matched no artist', () => {
    const orphans = findOrphanCollections(curated, new Set(['Seb McKinnon']));
    expect(orphans).toHaveLength(1);
    expect(orphans[0]).toEqual({ scryfallName: 'Noah Bradlee', collections: ['noah-bradley'] });
  });

  it('returns nothing when every entry matched', () => {
    expect(findOrphanCollections(curated, new Set(['Seb McKinnon', 'Noah Bradlee']))).toHaveLength(0);
  });
});

describe('formatCurationReport', () => {
  it('renders counts, sections, and orphan rows', () => {
    const variants = findNameVariants(['Chris Rush', 'Christopher Rush', 'Johannes Voß', 'Johannes Voss']);
    const orphans = findOrphanCollections([{ scryfallName: 'Noah Bradlee', openSeaCollections: ['noah-bradley'] }], new Set());
    const md = formatCurationReport(variants, orphans, '2026-06-15');
    expect(md).toContain('# Curation data-quality report');
    expect(md).toContain('Generated 2026-06-15');
    expect(md).toContain(`Suspected artist-name variants (${variants.length})`);
    expect(md).toContain('Orphan OpenSea collections (1)');
    expect(md).toContain('`Noah Bradlee`');
  });

  it('shows the empty states when there is nothing to report', () => {
    const md = formatCurationReport([], [], '2026-06-15');
    expect(md).toContain('_None detected._');
    expect(md).toContain('_None — every curated entry matched an artist._');
  });
});
