import { addUser, login } from './localAuth';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addInventoryEntry, getProducts, initializeStore, updateProductStock } from './store';
import { enqueueInventoryOperation, getPendingInventoryOperations, setInventoryAssociation, syncPendingInventory } from './inventorySync';
import { updateInventoryEntry } from './store';
import { supabaseClient } from './supabase';
import { resetLocalDatabaseForTests } from './localDatabase';

describe('inventory persistence and sync queue', async () => {
  beforeEach(async () => {
    vi.stubEnv('VITE_POS_SYNC_ENABLED', 'true');
    localStorage.clear();
    await resetLocalDatabaseForTests();
    await initializeStore();
    await addUser({ username: 'admin', name: 'Admin', role: 'admin', password: 'correct-horse-battery' }, true);
    await login('admin', 'correct-horse-battery');
    vi.spyOn(supabaseClient!.auth, 'getUser').mockResolvedValue({ data: { user: null }, error: null } as never);
    vi.spyOn(supabaseClient!, 'rpc').mockResolvedValue({ data: null, error: { message: 'v2 not deployed in test' } } as never);
  });

  afterEach(async () => {
    await syncPendingInventory();
    vi.restoreAllMocks(); vi.unstubAllEnvs();
  });

  it('links a new inventory entry to the created product and queues the atomic receipt', async () => {
    const entry = await addInventoryEntry({
      productId: '',
      productName: 'Coffee',
      barcode: 'coffee-001',
      quantityAdded: 8,
      purchasePrice: 2.5,
      salePrice: 4,
      salesmanName: 'Sam',
      date: '2026-09-28T10:00:00.000Z',
    });

    const [product] = getProducts();
    const [operation] = getPendingInventoryOperations();
    expect(entry.productId).toBe(product.id);
    expect(product.stockQuantity).toBe(8);
    expect(operation).toMatchObject({ type: 'receive', operationId: entry.id });
    expect(operation).toMatchObject({ entry: { id: entry.id, productId: product.id }, product: { id: product.id } });
  });

  it('keeps existing product identity and accumulates received stock by barcode', async () => {
    const first = await addInventoryEntry({
      productId: '', productName: 'Coffee', barcode: 'coffee-001', quantityAdded: 8,
      purchasePrice: 2.5, salePrice: 4, salesmanName: 'Sam', date: '2026-09-28T10:00:00.000Z',
    });
    const productId = first.productId;
    const second = await addInventoryEntry({
      productId: '', productName: 'Coffee', barcode: 'coffee-001', quantityAdded: 3,
      purchasePrice: 2.75, salePrice: 4.5, salesmanName: 'Sam', date: '2026-09-28T11:00:00.000Z',
    });

    expect(getProducts()).toHaveLength(1);
    expect(getProducts()[0]).toMatchObject({ id: productId, stockQuantity: 11, purchasePrice: 2.75, salePrice: 4.5 });
    expect(second.productId).toBe(productId);
    expect(getPendingInventoryOperations().filter(operation => operation.type === 'receive')).toHaveLength(2);
  });

  it('queues a stock change as a delta with a stable retry key', async () => {
    const entry = await addInventoryEntry({
      productId: '', productName: 'Coffee', barcode: 'coffee-001', quantityAdded: 8,
      purchasePrice: 2.5, salePrice: 4, salesmanName: 'Sam', date: '2026-09-28T10:00:00.000Z',
    });

    await updateProductStock(entry.productId, -2, `sale:sale-id:${entry.productId}`);
    const firstEnqueue = await enqueueInventoryOperation(
      { type: 'stock_delta', productId: entry.productId, quantityDelta: -2 },
      `sale:sale-id:${entry.productId}`,
    );

    expect(firstEnqueue).toBe(`sale:sale-id:${entry.productId}`);
    expect(getProducts()[0].stockQuantity).toBe(6);
    expect(getPendingInventoryOperations().filter(operation => operation.operationId === firstEnqueue)).toHaveLength(1);
  });

  it('binds queued work to existing business and branch identifiers', async () => {
    await setInventoryAssociation({
      businessId: 'existing-business-id',
      branchId: 'existing-branch-id',
      businessName: 'Current Store',
      branchName: 'Main',
      ownerUserId: 'authenticated-owner-id',
    });

    await addInventoryEntry({
      productId: '', productName: 'Coffee', barcode: 'coffee-001', quantityAdded: 8,
      purchasePrice: 2.5, salePrice: 4, salesmanName: 'Sam', date: '2026-09-28T10:00:00.000Z',
    });

    expect(getPendingInventoryOperations()[0]).toMatchObject({
      businessId: 'existing-business-id',
      branchId: 'existing-branch-id',
    });
  });

  it('queues descriptive inventory-entry edits without changing product stock', async () => {
    const entry = await addInventoryEntry({
      productId: '', productName: 'Coffee', barcode: 'coffee-001', quantityAdded: 8,
      purchasePrice: 2.5, salePrice: 4, salesmanName: 'Sam', date: '2026-09-28T10:00:00.000Z',
    });

    await updateInventoryEntry(entry.id, { salesmanName: 'Alex' });

    expect(getProducts()[0].stockQuantity).toBe(8);
    expect(getPendingInventoryOperations().at(-1)).toMatchObject({
      type: 'inventory_entry_update',
      entryId: entry.id,
      updates: { salesmanName: 'Alex' },
    });
  });

  it('accepts each inventory synchronization operation variant in the queue', async () => {
    await setInventoryAssociation({
      businessId: 'business-01',
      branchId: 'branch-01',
      businessName: 'Business 1',
      branchName: 'Main Branch',
      ownerUserId: 'owner-01',
    });

    const product = {
      id: 'product-01',
      barcode: 'temp-variant',
      name: 'Variant Product',
      stockQuantity: 5,
      purchasePrice: 3,
      salePrice: 5,
    };
    const entry = {
      id: 'entry-01',
      productId: 'product-01',
      productName: 'Variant Product',
      barcode: 'temp-variant',
      quantityAdded: 5,
      purchasePrice: 3,
      salePrice: 5,
      salesmanName: 'Sam',
      date: '2026-09-28T12:00:00.000Z',
    };

    await enqueueInventoryOperation({ type: 'receive', entry, product });
    await enqueueInventoryOperation({ type: 'stock_delta', productId: 'product-01', quantityDelta: 2 });
    await enqueueInventoryOperation({ type: 'product_upsert', product });
    await enqueueInventoryOperation({ type: 'product_update', productId: 'product-01', updates: { name: 'Updated Product' } });
    await enqueueInventoryOperation({ type: 'product_delete', productId: 'product-01' });
    await enqueueInventoryOperation({ type: 'inventory_entry_update', entryId: 'entry-01', updates: { salesmanName: 'Alex' } });
    await enqueueInventoryOperation({ type: 'inventory_entry_delete', entryId: 'entry-01' });

    const queue = getPendingInventoryOperations();
    expect(queue.map(operation => operation.type)).toEqual([
      'receive',
      'stock_delta',
      'product_upsert',
      'product_update',
      'product_delete',
      'inventory_entry_update',
      'inventory_entry_delete',
    ]);
    expect(queue[0]).toMatchObject({ type: 'receive', entry: { id: 'entry-01' }, product: { id: 'product-01' } });
    expect(queue[1]).toMatchObject({ type: 'stock_delta', productId: 'product-01', quantityDelta: 2 });
    expect(queue[2]).toMatchObject({ type: 'product_upsert', product: { id: 'product-01' } });
    expect(queue[3]).toMatchObject({ type: 'product_update', productId: 'product-01', updates: { name: 'Updated Product' } });
    expect(queue[4]).toMatchObject({ type: 'product_delete', productId: 'product-01' });
    expect(queue[5]).toMatchObject({ type: 'inventory_entry_update', entryId: 'entry-01', updates: { salesmanName: 'Alex' } });
    expect(queue[6]).toMatchObject({ type: 'inventory_entry_delete', entryId: 'entry-01' });
  });

  it('preserves operations enqueued while a Supabase request is in flight', async () => {
    if (!supabaseClient) throw new Error('Supabase test client is not configured');
    await setInventoryAssociation({ businessId: 'business-01', branchId: 'branch-01', businessName: 'Business', branchName: 'Main', ownerUserId: 'owner-01' });
    vi.spyOn(supabaseClient.auth, 'getUser').mockResolvedValue({ data: { user: { id: 'owner-01' } }, error: null } as never);
    let release!: (value: unknown) => void;
    const pending = new Promise(resolve => { release = resolve; });
    const rpc = vi.spyOn(supabaseClient, 'rpc').mockImplementation((name, args) => {
      if (name === 'pos_sync_protocol') return Promise.resolve({ data: { version: 2, revision: 3, atomic_refund_batches: true, atomic_product_adjustments: true, archived_refund_catalog: true, ledger_preserved: true }, error: null }) as never;
      const operation = (args as { p_operation: { operationId: string } }).p_operation;
      if (operation.operationId === 'first-operation') return pending as never;
      return Promise.resolve({ data: { operation_id: operation.operationId, confirmed: true, product_ids: {} }, error: null }) as never;
    });
    const entry = { id: 'entry-01', productId: 'product-01', productName: 'Test', barcode: 'test-01', quantityAdded: 2, purchasePrice: 1, salePrice: 2, salesmanName: 'Test', date: '2026-09-29' };
    const product = { id: 'product-01', barcode: 'test-01', name: 'Test', stockQuantity: 2, purchasePrice: 1, salePrice: 2 };
    await enqueueInventoryOperation({ type: 'receive', entry, product }, 'first-operation');
    const sync = syncPendingInventory();
    await vi.waitFor(() => expect(rpc.mock.calls.some(call => call[0] === 'pos_commit_operation')).toBe(true));
    await enqueueInventoryOperation({ type: 'stock_delta', productId: 'product-01', quantityDelta: -1 }, 'second-operation');
    release({ data: { operation_id: 'first-operation', confirmed: true, product_ids: {'product-01':'product-01'} }, error: null });
    await sync;
    expect(getPendingInventoryOperations()).toEqual([]);
  });
});
