import { saleSchema, refundSchema } from './dataValidation';
import type { Sale, Refund } from '@/types/pos';
import { stableJson } from './localDatabase';

type FinancialRecord = Sale | Refund;

// The RPC orders lines by product ID for locking/canonicalization. Compare that
// transport representation without ever writing it over an existing receipt.
// Only absent/false provenance and line order are equivalent; IDs, prices,
// quantities, totals, timestamps and every other field must match exactly.
function comparable(record: FinancialRecord): string {
  return stableJson({
    ...record,
    legacy: record.legacy === true,
    items: [...record.items].sort((a, b) => a.productId < b.productId ? -1 : a.productId > b.productId ? 1 : 0),
  });
}

export function mergeCloudFinancialHistory<T extends FinancialRecord>(
  kind: 'sale' | 'refund', incoming: T[], preserved: T[],
): T[] {
  const schema = kind === 'sale' ? saleSchema : refundSchema;
  const originals = new Map(preserved.map(record => [record.id, record]));
  const seen = new Set<string>();
  const additions: T[] = [];
  for (const raw of incoming) {
    // Verified-only endpoints cannot self-attest new legacy records. Validate
    // original objects without stripping unknown fields from the comparison.
    const record = { ...raw, legacy: false };
    schema.parse(record);
    if (seen.has(record.id)) throw new Error(`Duplicate cloud ${kind} ID (${record.id}). Local history remains unchanged.`);
    seen.add(record.id);
    if (new Set(record.items.map(item => item.productId)).size !== record.items.length) {
      throw new Error(`Duplicate cloud ${kind} product lines (${record.id}). Local history remains unchanged.`);
    }
    const original = originals.get(record.id);
    if (original) {
      if (original.legacy === true) {
        throw new Error(`Cloud ${kind} ID (${record.id}) conflicts with preserved legacy history; reviewed reconciliation is required.`);
      }
      if (comparable(original) !== comparable(record)) {
        throw new Error(`Cloud ${kind} (${record.id}) differs from immutable local financial history; administrator reconciliation is required. Local records remain unchanged.`);
      }
    } else additions.push(record as T);
  }
  for (const original of preserved) {
    if (!original.legacy && !seen.has(original.id)) {
      throw new Error(`Cloud snapshot omits committed local ${kind} (${original.id}). Local history remains unchanged pending reconciliation.`);
    }
  }
  // All preserved history, including orphaned legacy refunds, stays byte-for-
  // byte equivalent. A cloud refresh neither verifies nor replays it.
  return [...structuredClone(preserved), ...structuredClone(additions)];
}
