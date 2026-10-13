import { expect, it } from 'vitest';
import { validateCloudInventoryEntries, validateNewInventoryOperation } from './cloudReceiptIdentity';
import type { InventoryEntry } from '@/types/pos';
import type { InventorySyncOperation } from './inventorySync';
const receipt: InventoryEntry = { id: 'original', productId: '', productName: 'Coffee', barcode: '201', quantityAdded: 10, purchasePrice: 2, salePrice: 4, salesmanName: 'Supplier', date: '2020-01-01T00:00:00Z', legacy: true };
const incoming = () => { const { legacy: _legacy, ...raw } = receipt; return raw; };
it('preserves an exactly matching known historical receipt without inventing a product ID', () => {
  const before = structuredClone(receipt);
  expect(validateCloudInventoryEntries([incoming()], [receipt])).toEqual([before]);
  expect(receipt).toEqual(before);
});
it('never trusts a remote legacy flag, barcode, or another branch to bypass new identity checks', () => {
  for (const raw of [incoming(), { ...incoming(), legacy: true }, { ...incoming(), id: 'another' }]) {
    expect(() => validateCloudInventoryEntries([raw], [])).toThrow('New receipts require product identity');
  }
});
it('reports exact array positions and IDs for newly invalid receipts', () => {
  const valid = { ...incoming(), id: 'valid', productId: 'product' };
  expect(() => validateCloudInventoryEntries([valid, valid, incoming()], [])).toThrow('Cloud inventory receipt [2] (original)');
});
it('rejects changed historical quantity, identity, barcode, price, supplier or timestamp', () => {
  for (const change of [{ quantityAdded: 11 }, { productId: 'guessed' }, { barcode: 'different' }, { salePrice: 5 }, { salesmanName: 'another' }, { date: '2021-01-01' }]) {
    expect(() => validateCloudInventoryEntries([{ ...incoming(), ...change }], [receipt])).toThrow('differs from the cloud record');
  }
});
it('validates genuine new receipts strictly and cannot enqueue a historical receipt as new', () => {
  const valid = { ...incoming(), productId: 'product' };
  expect(validateCloudInventoryEntries([valid], [])).toEqual([{ ...valid, legacy: false }]);
  const operation = { type: 'receive', operationId: 'new', businessId: 'business', branchId: 'branch', entry: receipt, product: { id: 'product', name: 'Coffee', barcode: '201', stockQuantity: 10, salePrice: 4, purchasePrice: 2 } } as Extract<InventorySyncOperation, { type: 'receive' }>;
  expect(() => validateNewInventoryOperation(operation)).toThrow('Historical records cannot');
  operation.entry = { ...valid, legacy: false };
  expect(() => validateNewInventoryOperation(operation)).not.toThrow();
  operation.entry = { ...valid, productId: 'wrong', legacy: false };
  expect(() => validateNewInventoryOperation(operation)).toThrow('does not match');
});
