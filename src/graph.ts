/**
 * Production-graph structure: dependency depth, resolution order, consumer lookup.
 *
 * Depth drives allocation priority (§3.5): "simple factories have higher priority than
 * complex ones". Note depth does NOT track tech tier — Cannon is depth 2 while Rifle is
 * depth 3 (§8.4) — so priority will sometimes favour a higher-tier weapon.
 */
import type { Commodity, CommodityId } from "./types.ts";

export interface Graph {
  table: Map<CommodityId, Commodity>;
  depth: Map<CommodityId, number>;
  /** Commodities grouped by depth, shallowest first. */
  byDepth: CommodityId[][];
  /** For each commodity, who consumes it — ordered by consumer priority. */
  consumers: Map<CommodityId, CommodityId[]>;
  maxDepth: number;
}

export function buildGraph(table: Map<CommodityId, Commodity>): Graph {
  const depth = new Map<CommodityId, number>();
  const visiting = new Set<CommodityId>();

  const resolve = (id: CommodityId): number => {
    const cached = depth.get(id);
    if (cached !== undefined) return cached;
    const c = table.get(id);
    if (!c) throw new Error(`unknown commodity: ${id}`);
    if (visiting.has(id)) throw new Error(`cycle in production graph at: ${id}`);
    visiting.add(id);
    const inputs = Object.keys(c.inputs);
    const d = inputs.length === 0 ? 0 : 1 + Math.max(...inputs.map(resolve));
    visiting.delete(id);
    depth.set(id, d);
    return d;
  };
  for (const id of table.keys()) resolve(id);

  const maxDepth = Math.max(...depth.values());
  const order = [...table.keys()];
  const byDepth: CommodityId[][] = Array.from({ length: maxDepth + 1 }, () => []);
  for (const id of order) byDepth[depth.get(id)!]!.push(id);

  // Consumers sorted shallowest-first; table order breaks ties so behaviour is stable.
  const consumers = new Map<CommodityId, CommodityId[]>();
  for (const id of order) consumers.set(id, []);
  for (const c of table.values()) {
    for (const input of Object.keys(c.inputs)) consumers.get(input)!.push(c.id);
  }
  for (const list of consumers.values()) {
    list.sort(
      (x, y) => depth.get(x)! - depth.get(y)! || order.indexOf(x) - order.indexOf(y),
    );
  }

  return { table, depth, byDepth, consumers, maxDepth };
}
