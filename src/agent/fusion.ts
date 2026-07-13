// src/agent/fusion.ts
//
// Reciprocal Rank Fusion (RRF) - merges multiple ranked result lists into
// one, rewarding items that rank well across MULTIPLE lists. An item that
// surfaces for several query rephrasings is more likely genuinely relevant
// than one that spikes in a single list.
//
// RRF score for an item = sum over lists of 1 / (k + rank_in_that_list)
// where rank is 0-based and k dampens the contribution of low ranks (k=60
// is the standard default from the original RRF paper).
//
// Isolated behind a generic interface so it can be swapped for weighted
// fusion or a cross-encoder reranker later without touching the retrieve
// node. The retrieve node only depends on `fuse()`.

export interface RankedItem<T> {
  id: string;
  item: T;
}

export interface FusedItem<T> {
  id: string;
  item: T;
  score: number;
  /** How many input lists this item appeared in (a useful relevance signal). */
  listCount: number;
}

export interface FusionOptions {
  /** Damping constant. Higher = flatter contribution across ranks. */
  k?: number;
}

export function fuse<T>(
  lists: RankedItem<T>[][],
  options: FusionOptions = {},
): FusedItem<T>[] {
  const k = options.k ?? 60;
  const acc = new Map<string, FusedItem<T>>();

  for (const list of lists) {
    list.forEach((entry, rank) => {
      const contribution = 1 / (k + rank);
      const existing = acc.get(entry.id);
      if (existing) {
        existing.score += contribution;
        existing.listCount += 1;
      } else {
        acc.set(entry.id, {
          id: entry.id,
          item: entry.item,
          score: contribution,
          listCount: 1,
        });
      }
    });
  }

  return Array.from(acc.values()).sort((a, b) => b.score - a.score);
}