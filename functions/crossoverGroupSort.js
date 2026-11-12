/**
 * Sorting for the Notifications cards. The default order (newest bar first, then
 * list order) is served straight from Firestore; every other order is applied
 * here, in memory, over the filtered set (see queryCrossoverGroupsPage) so no new
 * composite indexes are needed.
 *
 *   sort  'time'  - crossover bar time (candleTimestamp), then list order
 *         'alpha' - symbol A-Z
 *         'price' - stock value: the close price of the crossover bar
 *   order 'asc' | 'desc'
 */

export const GROUP_SORTS = ["time", "alpha", "price"];
export const GROUP_ORDERS = ["asc", "desc"];
export const DEFAULT_GROUP_SORT = "time";
export const DEFAULT_GROUP_ORDER = "desc";

// True when Firestore's own ordering (time, newest first) already is the answer.
export const isDefaultGroupOrder = (
  sort = DEFAULT_GROUP_SORT,
  order = DEFAULT_GROUP_ORDER,
) => sort === DEFAULT_GROUP_SORT && order === DEFAULT_GROUP_ORDER;

const bySymbol = (a, b) => String(a.symbol).localeCompare(String(b.symbol));
const byList = (a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0);
const isNum = (v) => typeof v === "number" && Number.isFinite(v);

/**
 * Returns a new array sorted by `sort` / `order`. Cards without a numeric price
 * always sort last, whichever the direction. Ties fall back to a stable,
 * sensible order so pages never shuffle.
 */
export function sortGroups(
  groups,
  sort = DEFAULT_GROUP_SORT,
  order = DEFAULT_GROUP_ORDER,
) {
  const dir = order === "asc" ? 1 : -1;
  const compare = {
    alpha: (a, b) =>
      dir * bySymbol(a, b) || b.candleTimestamp - a.candleTimestamp,
    price: (a, b) => {
      if (!isNum(a.closePrice) || !isNum(b.closePrice))
        return (
          (isNum(b.closePrice) ? 1 : 0) - (isNum(a.closePrice) ? 1 : 0) ||
          bySymbol(a, b)
        );
      return dir * (a.closePrice - b.closePrice) || bySymbol(a, b);
    },
    // Bar time, then indices before stocks within one bar, then list order.
    timeindex: (a, b) =>
      dir * (a.candleTimestamp - b.candleTimestamp) ||
      (b.isIndex ? 1 : 0) - (a.isIndex ? 1 : 0) ||
      byList(a, b) ||
      bySymbol(a, b),
    time: (a, b) =>
      dir * (a.candleTimestamp - b.candleTimestamp) ||
      byList(a, b) ||
      bySymbol(a, b),
  }[sort];
  return [...groups].sort(compare);
}
