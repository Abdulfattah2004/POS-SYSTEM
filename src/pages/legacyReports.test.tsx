import {beforeEach,afterEach,expect,it,vi} from 'vitest';
import {cleanup,render,fireEvent,screen} from '@testing-library/react';
import {initializeStore,getSales,getProducts} from '@/lib/store';
import {addUser,login} from '@/lib/localAuth';
import {emptyBranch,getLocalState,localTransaction,resetLocalDatabaseForTests,stableJson,readVisibleCollection,visibleBranch} from '@/lib/localDatabase';
import type {Sale} from '@/types/pos';
import ReportsPage from './ReportsPage';
import AnalyticsPage from './AnalyticsPage';
import ReceiptsPage from './ReceiptsPage';
vi.mock('@/contexts/AuthContext',()=>({useAuth:()=>({user:{id:'fixture-admin',name:'Admin',role:'admin'},isAdmin:true})}));
const history=():Sale[]=>Array.from({length:22220},(_,i)=>({id:`original-${i}`,legacy:true,items:i%2?[]:[{productId:'original-product',productName:'Coffee',barcode:'201',quantity:1,salePrice:2,purchasePrice:1,currency:'USD'}],subtotal:2,total:2,currency:'USD',exchangeRate:89500,cashierName:'Original cashier',date:'2026-09-30T22:30:00Z',refunded:false}));
beforeEach(async()=>{
  localStorage.clear();await resetLocalDatabaseForTests();await initializeStore();await addUser({username:'admin',name:'Admin',role:'admin',password:'synthetic-test-password'},true);await login('admin','synthetic-test-password');
  await localTransaction(state=>{state.branches.unassigned.sales=history();state.association={businessId:'business',branchId:'main',ownerUserId:'owner',businessName:'Daily Supermarket',branchName:'Main Branch'};state.branches['business/main']=emptyBranch();});
});
afterEach(()=>cleanup());
it('Receipts scope differs only when unassigned ownership is unproven; reports explicitly expose unassigned history without moving it',()=>{
  const before=stableJson(getLocalState());expect(getSales()).toHaveLength(0);
  const view=render(<ReportsPage/>);expect(screen.getByRole('combobox',{name:'Reporting scope'})).toHaveValue('unassigned');
  expect(screen.getByText(/22,220 preserved sales/)).toBeInTheDocument();expect(screen.getByText('Stored gross sales: $44440.00')).toBeInTheDocument();
  expect(view.container.querySelectorAll('tbody tr')).toHaveLength(50);fireEvent.click(screen.getByRole('button',{name:'Next historical page'}));expect(screen.getByText('original-50')).toBeInTheDocument();
  fireEvent.change(screen.getByRole('combobox',{name:'Historical period'}),{target:{value:'daily'}});fireEvent.change(screen.getByLabelText('Historical date from'),{target:{value:'2026-10-01'}});expect(screen.getByText(/22,220 preserved sales/)).toBeInTheDocument();
  fireEvent.change(screen.getByRole('combobox',{name:'Reporting scope'}),{target:{value:'verified'}});expect(screen.getByText('No sales for this period')).toBeInTheDocument();
  expect(stableJson(getLocalState())).toBe(before);expect(getLocalState().outbox).toEqual([]);
},15000);
it('Analytics shows original book totals and only available item details with explicit reconciliation status',()=>{
  render(<AnalyticsPage/>);expect(screen.getByText(/Preserved local history/)).toBeInTheDocument();expect(screen.getByText('Coffee: 11110 sold in available historical lines')).toBeInTheDocument();expect(screen.getByText(/11,110 sales without item details/)).toBeInTheDocument();expect(getLocalState().branches.unassigned.sales).toHaveLength(22220);
});
it('visible receipt records and optimized collection reads retain identical IDs and detached inventory',async()=>{
  await localTransaction(state=>{state.project1Settings={business_id:'business',branch_id:'main'};state.branches.unassigned.products=[{id:'original',name:'Original',barcode:'201',stockQuantity:67,purchasePrice:1,salePrice:2}];});
  const state=getLocalState();expect(readVisibleCollection('sales')).toEqual(visibleBranch(state).sales);expect(getSales()).toHaveLength(22220);
  const products=getProducts();products[0].stockQuantity=999;expect(getProducts()[0].stockQuantity).toBe(67);
  const view=render(<ReceiptsPage/>);expect(view.container.querySelectorAll('button.w-full')).toHaveLength(50);expect(screen.getByText(/22,220 receipts/)).toBeInTheDocument();fireEvent.click(screen.getByRole('button',{name:'Next receipts'}));expect(screen.getByText(/Page 2 of 445/)).toBeInTheDocument();
},15000);
it('invalid historical dates produce an error rather than zero totals',async()=>{
  await localTransaction(state=>{state.branches.unassigned.sales[0].date='damaged-original-date';});
  render(<ReportsPage/>);expect(screen.getByRole('alert')).toHaveTextContent('Historical report unavailable');expect(screen.queryByText('Stored gross sales: $0.00')).toBeNull();
});
