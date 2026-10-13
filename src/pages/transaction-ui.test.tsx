import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { addUser, login } from '@/lib/localAuth';
import { resetLocalDatabaseForTests } from '@/lib/localDatabase';
import { initializeStore, addInventoryEntry, updateProductStock, getInventoryEntries, getProducts, getSales } from '@/lib/store';
import * as sync from '@/lib/inventorySync';
import InventoryEntryPage from './InventoryEntryPage';
import POSPage from './POSPage';
import Layout from '@/components/Layout';
import { MemoryRouter } from 'react-router-dom';
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { name: 'Admin', role: 'admin' }, isAdmin: true }) }));
beforeEach(async () => {
  localStorage.clear(); await resetLocalDatabaseForTests(); await initializeStore();
  await addUser({ username: 'admin', name: 'Admin', role: 'admin', password: 'correct-horse-battery' }, true);
  await login('admin', 'correct-horse-battery');
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
it('removes sidebar stock alerts and global messages while unknown scans still show a local error without a sale',async()=>{
 const beforeProducts=getProducts();const view=render(<MemoryRouter><Layout><POSPage/></Layout></MemoryRouter>);
 expect(view.queryByLabelText('Stock alerts')).toBeNull();expect(view.queryByText('Low Stock')).toBeNull();expect(view.queryByText('Out of Stock')).toBeNull();
 const input=view.getByPlaceholderText('Scan barcode or type product code...');
 fireEvent.change(input,{target:{value:'unknown-barcode'}});fireEvent.keyDown(input,{key:'Enter'});
 const error=view.getByRole('alert');expect(error).toHaveTextContent('Product not found');
 expect(input.closest('.mb-6')).toContainElement(error);expect(view.queryByLabelText('Application messages')).toBeNull();
 expect(getProducts()).toEqual(beforeProducts);expect(getSales()).toEqual([]);
});
it('rapid repeated receipt submissions produce one receipt and one stock increase', async () => {
  let release!: (value: string[]) => void;
  vi.spyOn(sync, 'syncPendingInventory').mockReturnValue(new Promise(resolve => { release = resolve; }));
  const view = render(<InventoryEntryPage />);
  fireEvent.change(view.getByPlaceholderText('Product name'), { target: { value: 'Coffee' } });
  fireEvent.change(view.getByPlaceholderText('Scan or enter barcode'), { target: { value: '123' } });
  fireEvent.change(view.getByPlaceholderText('0'), { target: { value: '3' } });
  const prices = view.getAllByPlaceholderText('0.00');
  fireEvent.change(prices[0], { target: { value: '1' } });
  fireEvent.change(prices[1], { target: { value: '2' } });
  const submit = view.getByRole('button', { name: 'Add to Inventory' });
  fireEvent.click(submit); fireEvent.click(submit);
  await waitFor(() => expect(getInventoryEntries()).toHaveLength(1));
  expect(getProducts()[0].stockQuantity).toBe(3);
  release([]);
  await waitFor(() => expect(submit).not.toBeDisabled());
});
it('scanner Enter and repeated checkout clicks create one sale of one unit', async () => {
  await addInventoryEntry({ productId: '', productName: 'Coffee', barcode: '123', quantityAdded: 3, purchasePrice: 1, salePrice: 2, salesmanName: 'Sam', date: '2026-09-30' });
  const view = render(<POSPage />);
  const input = view.getByPlaceholderText('Scan barcode or type product code...');
  fireEvent.change(input, { target: { value: '123' } });
  for (const key of ['1', '2', '3', 'Enter']) fireEvent.keyDown(input, { key });
  const checkout = view.getByRole('button', { name: /Complete Sale/ });
  fireEvent.click(checkout); fireEvent.click(checkout);
  await waitFor(() => expect(getSales()).toHaveLength(1));
  expect(getSales()[0].items[0].quantity).toBe(1);
  expect(getProducts()[0].stockQuantity).toBe(2);
});

it('sells an out-of-stock item through the POS screen and displays a negative inventory balance', async () => {
  const receipt=await addInventoryEntry({productId:'',productName:'Coffee',barcode:'zero',quantityAdded:1,purchasePrice:1,salePrice:2,salesmanName:'Sam',date:'2026-10-05'});
  await updateProductStock(receipt.productId,-1,'zero-stock');
  const view=render(<POSPage />);
  const input=view.getByPlaceholderText('Scan barcode or type product code...');
  fireEvent.change(input,{target:{value:'zero'}});fireEvent.keyDown(input,{key:'Enter'});
  const checkout=view.getByRole('button',{name:/Complete Sale/});
  expect(checkout).not.toBeDisabled();fireEvent.click(checkout);fireEvent.click(checkout);
  await waitFor(()=>expect(getSales()).toHaveLength(1));
  expect(getProducts()[0].stockQuantity).toBe(-1);
});

it('holds, reloads the screen, resumes and checks out one cart without premature stock or sales effects',async()=>{
 await addInventoryEntry({productId:'',productName:'Coffee',barcode:'held-ui',quantityAdded:3,purchasePrice:1,salePrice:2,salesmanName:'Sam',date:'2026-10-05'});
 let view=render(<POSPage />);const input=view.getByPlaceholderText('Scan barcode or type product code...');fireEvent.change(input,{target:{value:'held-ui'}});fireEvent.keyDown(input,{key:'Enter'});
 fireEvent.change(view.getByPlaceholderText('Customer or hold note'),{target:{value:'Waiting customer'}});fireEvent.click(view.getByRole('button',{name:'Hold Sale'}));
 await waitFor(()=>expect(view.getByText('Waiting customer')).toBeInTheDocument());expect(getSales()).toEqual([]);expect(getProducts()[0].stockQuantity).toBe(3);
 view.unmount();view=render(<POSPage />);expect(view.getByText('Waiting customer')).toBeInTheDocument();fireEvent.click(view.getByRole('button',{name:'Resume'}));fireEvent.click(view.getByRole('button',{name:/Complete Sale/}));
 await waitFor(()=>expect(getSales()).toHaveLength(1));expect(getProducts()[0].stockQuantity).toBe(2);expect(view.queryByRole('button',{name:'Resume'})).toBeNull();
});
