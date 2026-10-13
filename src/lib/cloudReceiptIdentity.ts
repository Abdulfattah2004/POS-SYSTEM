import { z } from 'zod';
import { entrySchema, validateOperations } from './dataValidation';
import type { InventoryEntry } from '@/types/pos';
import type { InventorySyncOperation } from './inventorySync';

// Only the current, authorized local branch can attest to preserved history.
// A remote flag, barcode match or similar name is never legacy identity proof.
const originalFields = (entry: InventoryEntry) => ({
  id: entry.id, productId: entry.productId, productName: entry.productName,
  barcode: entry.barcode, quantityAdded: entry.quantityAdded,
  purchasePrice: entry.purchasePrice, salePrice: entry.salePrice,
  salesmanName: entry.salesmanName, date: entry.date,
});
// Required fields are checked by Zod at runtime. This project compiles with
// strictNullChecks off, which makes Zod's inferred object properties optional.
const parseEntry = (value: unknown): InventoryEntry => entrySchema.parse(value) as InventoryEntry;
export function validateCloudInventoryEntries(value: unknown, preserved: InventoryEntry[]): InventoryEntry[] {
  return z.array(z.unknown()).parse(value).map((raw, index) => {
    try {
      const input = z.object({ id: z.string().min(1) }).passthrough().parse(raw);
      const original = preserved.find(entry => entry.id === input.id && entry.legacy === true);
      if (original) {
        const incoming = parseEntry({ ...input, legacy: true });
        const known = parseEntry(original);
        if (JSON.stringify(originalFields(incoming)) !== JSON.stringify(originalFields(known))) {
          throw new Error('Preserved historical receipt differs from the cloud record; administrator reconciliation is required');
        }
        // Retain the exact original record, including its deliberately blank ID.
        return structuredClone(original);
      }
      // The endpoint must not self-authorize a new or foreign legacy receipt.
      return parseEntry({ ...input, legacy: false });
    } catch (error) {
      const reason = error instanceof z.ZodError ? error.issues.map(issue => issue.message).join('; ') : error instanceof Error ? error.message : 'Invalid inventory receipt';
      const recordId = typeof raw === 'object' && raw !== null && 'id' in raw && typeof raw.id === 'string' ? raw.id : 'unknown';
      throw new Error(`Cloud inventory receipt [${index}] (${recordId}): ${reason}. Local records remain unchanged.`);
    }
  });
}
export function validateNewInventoryOperation(operation: InventorySyncOperation): void {
  const record = operation as unknown as Record<string, unknown>;
  const strict = (value: unknown) => {
    const object = z.object({ legacy: z.boolean().optional() }).passthrough().parse(value);
    if (object.legacy === true) throw new Error('Historical records cannot be submitted as new transactions.');
    return { ...object, legacy: false };
  };
  let checked: Record<string, unknown> = { ...record };
  if (operation.type === 'receive') {
    checked = { ...checked, entry: strict(operation.entry) };
    if (operation.entry.productId !== operation.product.id) throw new Error('New inventory receipt product identity does not match its product.');
  }
  if (operation.type === 'sale') checked.sale = strict(operation.sale);
  if (operation.type === 'refund') checked = { ...checked, refund: strict(operation.refund), originalSale: strict(operation.originalSale) };
  if (operation.type === 'refund_batch') checked = { ...checked, refunds: operation.refunds.map(strict), originalSales: operation.originalSales.map(strict) };
  validateOperations([checked]);
}
