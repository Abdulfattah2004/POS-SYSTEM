import { z } from 'zod';
const id = z.string().min(1);
const quantity = z.number().int().min(0).max(2147483647);
const price = z.number().finite().nonnegative();
const date = z.string().refine(value => Number.isFinite(Date.parse(value)), 'Invalid date');
const currency = z.enum(['USD', 'LBP']);
export const productSchema = z.object({ legacy: z.boolean().optional(), isActive: z.boolean().optional(), id, barcode: id, name: id, stockQuantity: z.number().int().min(-2147483648).max(2147483647), purchasePrice: price, salePrice: price });
const line = z.object({ productId: id, productName: id, barcode: id, quantity: quantity.min(1), salePrice: price, purchasePrice: price, currency });
export const saleSchema = z.object({ id, items: z.array(line), subtotal: price, total: price, currency, exchangeRate: z.number().finite().positive(), cashierName: z.string(), date, refunded: z.boolean(), legacy: z.boolean().optional() }).refine(sale => sale.legacy || sale.items.length > 0, 'New sales require complete item lines');
export const refundSchema = z.object({ id, saleId: id, legacy: z.boolean().optional(), items: z.array(line), totalRefunded: price, currency, exchangeRate: z.number().finite().positive().optional(), cashierName: z.string(), date }).refine(r => r.legacy || r.items.length > 0, 'New refunds require items');
export const entrySchema = z.object({ id, productId: z.string(), legacy: z.boolean().optional(), productName: id, barcode: id, quantityAdded: quantity.min(1), purchasePrice: price, salePrice: price, salesmanName: z.string(), date }).refine(e => e.legacy || e.productId.length > 0, 'New receipts require product identity');
export const associationSchema = z.object({ businessId: id, branchId: id, ownerUserId: id, businessName: z.string(), branchName: z.string() }).nullable();
export function validateOperations(value: unknown) {
  const scope = z.object({ operationId: id, businessId: id.nullable(), branchId: id.nullable(), type: z.enum(['receive', 'stock_delta', 'sale', 'refund', 'refund_batch', 'product_upsert', 'product_update', 'product_adjust', 'product_delete', 'inventory_entry_update', 'inventory_entry_delete']), wirePayload: z.string().optional() });
  const seen = new Set<string>();
  for (const raw of z.array(z.unknown()).parse(value)) {
    const operation = scope.parse(raw);
    if (seen.has(operation.operationId)) throw new Error('Duplicate persisted operation IDs.');
    seen.add(operation.operationId);
    const data = raw as Record<string, unknown>;
    if (operation.type === 'receive') { entrySchema.parse(data.entry); productSchema.parse(data.product); }
    if (operation.type === 'sale') saleSchema.parse(data.sale);
    if (operation.type === 'refund') { refundSchema.parse(data.refund); saleSchema.parse(data.originalSale); }
    if (operation.type === 'refund_batch') { z.array(refundSchema).min(1).max(100).parse(data.refunds); z.array(saleSchema).min(1).parse(data.originalSales); }
    if (operation.type === 'product_upsert') productSchema.parse(data.product);
    if (operation.type === 'product_adjust') { id.parse(data.productId); z.number().int().min(-2147483647).max(2147483647).parse(data.quantityDelta); z.object({ name: id.optional(), barcode: id.optional(), purchasePrice: price.optional(), salePrice: price.optional() }).strict().parse(data.updates); }
    if (operation.type === 'stock_delta') { id.parse(data.productId); z.number().int().finite().min(-2147483647).max(2147483647).refine(value => value !== 0).parse(data.quantityDelta); }
    if (operation.type === 'product_update' || operation.type === 'product_delete') id.parse(data.productId);
    if (operation.type === 'inventory_entry_update' || operation.type === 'inventory_entry_delete') id.parse(data.entryId);
    if (operation.wirePayload) {
      const wire = scope.parse(JSON.parse(operation.wirePayload));
      if (wire.operationId !== operation.operationId || wire.businessId !== operation.businessId || wire.branchId !== operation.branchId || wire.type !== operation.type) throw new Error('Persisted operation payload/scope conflict.');
    }
  }
}
export function validateBranchData(value: { products: unknown; sales: unknown; refunds: unknown; entries: unknown; heldSales?: unknown; exchangeRate?: number; allowNegativeStock?: boolean; completed?: unknown; productAliases?: unknown }) {
  if(value.heldSales!==undefined) {
    const holds=z.array(z.object({id,label:z.string(),createdAt:date,userId:id,cashierName:z.string(),currency,items:z.array(z.object({productId:id,quantity:quantity.min(1),salePrice:price})).min(1)})).parse(value.heldSales);
    if(new Set(holds.map(hold=>hold.id)).size!==holds.length)throw new Error('Duplicate held sale IDs.');
  }
  if (value.allowNegativeStock !== undefined) z.boolean().parse(value.allowNegativeStock);
  if (value.completed !== undefined) z.record(z.object({ request: z.string(), result: z.unknown() })).parse(value.completed);
  if (value.productAliases !== undefined) z.record(z.string().min(1)).parse(value.productAliases);
  if (value.exchangeRate !== undefined) z.number().finite().positive().parse(value.exchangeRate);
  z.array(productSchema).parse(value.products);
  z.array(saleSchema).parse(value.sales);
  z.array(refundSchema).parse(value.refunds);
  z.array(entrySchema).parse(value.entries);
  for (const collection of [value.products, value.sales, value.refunds, value.entries] as { id: string }[][]) {
    if (new Set(collection.map(item => item.id)).size !== collection.length) throw new Error('Duplicate record IDs in persisted data.');
  }
}
