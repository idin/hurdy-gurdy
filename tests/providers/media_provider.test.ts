import { describe, expect, test } from "vitest";

import { fetchAllPages, type Page } from "../../src/providers/media_provider";

function pagesOf(items: number[], pageSize: number): (cursor: string | undefined) => Promise<Page<number>> {
  return async (cursor) => {
    const start = cursor ? Number(cursor) : 0;
    const slice = items.slice(start, start + pageSize);
    const nextStart = start + pageSize;
    return {
      items: slice,
      nextCursor: nextStart < items.length ? String(nextStart) : null,
      total: items.length,
    };
  };
}

describe("fetchAllPages", () => {
  test("follows nextCursor until it is null, returning every item", async () => {
    const items = await fetchAllPages(pagesOf([1, 2, 3, 4, 5], 2), { maxPages: 10 });
    expect(items).toEqual([1, 2, 3, 4, 5]);
  });

  test("a single page needs no cursor following", async () => {
    const items = await fetchAllPages(pagesOf([1, 2], 5), { maxPages: 10 });
    expect(items).toEqual([1, 2]);
  });

  test("an empty list returns empty, not an error", async () => {
    const items = await fetchAllPages(pagesOf([], 5), { maxPages: 10 });
    expect(items).toEqual([]);
  });

  test("a cursor that never terminates throws rather than looping forever", async () => {
    const neverEnds = async (): Promise<Page<number>> => ({
      items: [1],
      nextCursor: "always-more",
      total: null,
    });

    await expect(fetchAllPages(neverEnds, { maxPages: 5 })).rejects.toThrow(/did not terminate/);
  });
});
