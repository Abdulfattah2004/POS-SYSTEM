import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import {cleanup,fireEvent,render,waitFor} from '@testing-library/react';
import {addUser,login} from '@/lib/localAuth';
import {initializeStore,addInventoryEntry,getProducts,getSales,getRefunds,getInventoryEntries,addSale,setExchangeRate,updateProduct} from '@/lib/store';
import {resetLocalDatabaseForTests,localTransaction} from '@/lib/localDatabase';
import POSPage from './POSPage';
import InventoryPage from './InventoryPage';
import RefundsPage from './RefundsPage';
import ReportsPage from './ReportsPage';
import SalesmenPage from './SalesmenPage';
import {readPendingRequest} from '@/lib/pendingRequest';
vi.mock('@/contexts/AuthContext',()=>({useAuth:()=>({user:{id:'test-admin',name:'Admin',role:'admin'},isAdmin:true})}));
let productId:string;
beforeEach(async()=>{
 localStorage.clear();await resetLocalDatabaseForTests();await initializeStore();
 await addUser({username:'qa-admin',name:'Admin',role:'admin',password:'synthetic-qa-password'},true);await login('qa-admin','synthetic-qa-password');
 productId=(await addInventoryEntry({productId:'',productName:'Coffee',barcode:'qa-coffee',quantityAdded:10,purchasePrice:1,salePrice:2,salesmanName:'Supplier',date:new Date().toISOString()})).productId;
});
afterEach(()=>{cleanup();vi.restoreAllMocks();});
function scan(view:ReturnType<typeof render>,code='qa-coffee'){
 const input=view.getByPlaceholderText('Scan barcode or type product code...');fireEvent.change(input,{target:{value:code}});fireEvent.keyDown(input,{key:'Enter'});
}
it('cart controls add by exact product name, merge lines, change integer quantity, remove and clear',()=>{
 const view=render(<POSPage/>);expect(view.getByRole('button',{name:/Complete Sale/})).toBeDisabled();
 scan(view,'Coffee');scan(view);expect(view.getByRole('spinbutton',{name:'Quantity for Coffee'})).toHaveValue(2);
 fireEvent.click(view.getByRole('button',{name:'Increase Coffee'}));fireEvent.click(view.getByRole('button',{name:'Decrease Coffee'}));
 fireEvent.change(view.getByRole('spinbutton',{name:'Quantity for Coffee'}),{target:{value:'1.5'}});expect(view.getByRole('spinbutton',{name:'Quantity for Coffee'})).toHaveValue(2);
 fireEvent.change(view.getByRole('spinbutton',{name:'Quantity for Coffee'}),{target:{value:'2147483648'}});expect(view.getByRole('spinbutton',{name:'Quantity for Coffee'})).toHaveValue(2);
 fireEvent.click(view.getByRole('button',{name:'Remove Coffee'}));expect(view.getByRole('button',{name:/Complete Sale/})).toBeDisabled();
 scan(view);fireEvent.click(view.getByRole('button',{name:'Clear current cart'}));expect(view.getByRole('button',{name:'Hold Sale'})).toBeDisabled();expect(getSales()).toEqual([]);expect(getProducts()[0].stockQuantity).toBe(10);
});
it('unknown and archived barcodes cannot enter checkout',async()=>{
 const view=render(<POSPage/>);scan(view,'missing');expect(view.getByRole('button',{name:/Complete Sale/})).toBeDisabled();
 await localTransaction(state=>{state.branches.unassigned.products[0].isActive=false;});scan(view);expect(view.getByRole('button',{name:/Complete Sale/})).toBeDisabled();expect(getSales()).toEqual([]);
});
it('a checkout restored after interruption displays its saved amount and retries exactly once',async()=>{
 const p=getProducts()[0];localStorage.setItem('pos_checkout_v3:test-admin:unassigned',JSON.stringify({id:'saved-checkout',payload:{items:[{productId:p.id,productName:p.name,barcode:p.barcode,quantity:2,salePrice:2,purchasePrice:1,currency:'USD'}],subtotal:4,total:4,currency:'USD',exchangeRate:89500,cashierName:'Admin',date:new Date().toISOString(),refunded:false}}));
 const view=render(<POSPage/>);await view.findByText(/Saved transaction: saved-checkout/);expect(view.getByText(/Saved transaction:/)).toHaveTextContent('$4.00');expect(view.getByRole('button',{name:'$ USD'})).toBeDisabled();expect(view.getByRole('button',{name:'Add'})).toBeDisabled();
 const retry=view.getByRole('button',{name:'Retry saved checkout'});fireEvent.click(retry);fireEvent.click(retry);await waitFor(()=>expect(view.queryByRole('button',{name:'Retry saved checkout'})).toBeNull());expect(getSales()).toHaveLength(1);expect(getProducts()[0].stockQuantity).toBe(8);expect(localStorage.getItem('pos_checkout_v3:test-admin:unassigned')).not.toBeNull();expect(readPendingRequest('pos_checkout_v3:test-admin:unassigned')).toBeNull();
});
it('rendering recent historical refunds does not reorder the authoritative local state',async()=>{
 await localTransaction(state=>{state.branches.unassigned.refunds=[{id:'older',saleId:'legacy',legacy:true,items:[],totalRefunded:0,currency:'USD',date:'2026-01-01',cashierName:'Original'},{id:'newer',saleId:'legacy',legacy:true,items:[],totalRefunded:0,currency:'USD',date:'2026-10-01',cashierName:'Original'}];});
 const before=JSON.stringify(getRefunds());render(<RefundsPage/>);expect(JSON.stringify(getRefunds())).toBe(before);
});
it('LBP checkout records settlement currency and the correct rate with USD item prices',async()=>{
 await setExchangeRate(100000);const view=render(<POSPage/>);scan(view);fireEvent.click(view.getByRole('button',{name:'L.L LBP'}));fireEvent.click(view.getByRole('button',{name:/Complete Sale/}));
 await waitFor(()=>expect(getSales()).toHaveLength(1));expect(getSales()[0]).toMatchObject({subtotal:2,total:200000,currency:'LBP',exchangeRate:100000});expect(getSales()[0].items[0].salePrice).toBe(2);expect(getProducts()[0].stockQuantity).toBe(9);
});
it('the displayed LBP checkout equals the committed amount for a retained fractional product price',async()=>{
 await updateProduct(productId,{salePrice:0.333});const view=render(<POSPage/>);scan(view);fireEvent.click(view.getByRole('button',{name:'L.L LBP'}));expect(view.getByText('29,535 L.L')).toBeInTheDocument();fireEvent.click(view.getByRole('button',{name:/Complete Sale/}));await waitFor(()=>expect(getSales()).toHaveLength(1));expect(getSales()[0]).toMatchObject({subtotal:0.33,total:29535});
});
it('batch refund screen displays the sum of individually rounded original-sale settlements',async()=>{
 await updateProduct(productId,{salePrice:0.01});await setExchangeRate(150);const p=getProducts()[0];
 for(const id of ['parent-one','parent-two'])await addSale({items:[{productId:p.id,productName:p.name,barcode:p.barcode,quantity:1,salePrice:0.01,purchasePrice:1,currency:'USD'}],subtotal:0.01,total:0.01,currency:'USD',exchangeRate:150,cashierName:'Admin',date:new Date().toISOString(),refunded:false},id);
 vi.spyOn(window,'confirm').mockReturnValue(true);const view=render(<RefundsPage/>);const input=view.getByPlaceholderText(/Scan barcode/);
 for(let n=0;n<2;n++){fireEvent.change(input,{target:{value:'qa-coffee'}});fireEvent.keyDown(input,{key:'Enter'});}
 fireEvent.click(view.getByRole('button',{name:'L.L LBP'}));expect(view.getByText('4 L.L')).toBeInTheDocument();fireEvent.click(view.getByRole('button',{name:'Complete Refund'}));await waitFor(()=>expect(getRefunds()).toHaveLength(2));expect(getRefunds().reduce((sum,refund)=>sum+refund.totalRefunded,0)).toBe(4);expect(getProducts()[0].stockQuantity).toBe(10);
});
it('inventory edit cancel, barcode/name edit, negative stock, archive and archived filter preserve history',async()=>{
 vi.spyOn(window,'confirm').mockReturnValue(true);const view=render(<InventoryPage/>);
 fireEvent.click(view.getByRole('button',{name:'Edit Coffee'}));fireEvent.change(view.getByLabelText('Product name'),{target:{value:'Wrong'}});fireEvent.click(view.getByRole('button',{name:'Cancel product edit'}));expect(getProducts()[0].name).toBe('Coffee');
 fireEvent.click(view.getByRole('button',{name:'Edit Coffee'}));fireEvent.change(view.getByLabelText('Product name'),{target:{value:'New Coffee'}});fireEvent.change(view.getByLabelText('Barcode'),{target:{value:'new-code'}});
 fireEvent.change(view.getAllByRole('spinbutton')[0],{target:{value:'-4'}});fireEvent.click(view.getByRole('button',{name:'Save Coffee'}));
 await waitFor(()=>expect(getProducts()[0].name).toBe('New Coffee'));expect(getProducts()[0]).toMatchObject({id:productId,barcode:'new-code',stockQuantity:-4});
 fireEvent.click(view.getByRole('button',{name:'Archive New Coffee'}));await waitFor(()=>expect(getProducts()).toEqual([]));fireEvent.click(view.getByRole('checkbox',{name:'Include archived products'}));expect(view.getByText('New Coffee')).toBeInTheDocument();expect(getInventoryEntries()).toHaveLength(1);
});
it('refund scanner and rapid confirm restore one unit exactly once and stop already-refunded lines',async()=>{
 const p=getProducts()[0];await addSale({items:[{productId:p.id,productName:p.name,barcode:p.barcode,quantity:1,salePrice:2,purchasePrice:1,currency:'USD'}],subtotal:2,total:2,currency:'USD',exchangeRate:89500,cashierName:'Admin',date:new Date().toISOString(),refunded:false},'qa-original-sale');
 vi.spyOn(window,'confirm').mockReturnValue(true);const view=render(<RefundsPage/>);const input=view.getByPlaceholderText(/Scan barcode/);fireEvent.change(input,{target:{value:'qa-coffee'}});fireEvent.keyDown(input,{key:'Enter'});
 const submit=view.getByRole('button',{name:/Complete Refund|Process Refund/});fireEvent.click(submit);fireEvent.click(submit);await waitFor(()=>expect(getRefunds()).toHaveLength(1));expect(getProducts()[0].stockQuantity).toBe(10);
 fireEvent.change(input,{target:{value:'qa-coffee'}});fireEvent.keyDown(input,{key:'Enter'});expect(submit).toBeDisabled();expect(getRefunds()).toHaveLength(1);
});
it('operator revenue summaries exclude unverified historical sales',async()=>{
 await localTransaction(state=>{state.branches.unassigned.sales.push({id:'historical',legacy:true,items:[{productId,productName:'Coffee',barcode:'qa-coffee',quantity:1,salePrice:987.65,purchasePrice:1,currency:'USD'}],subtotal:987.65,total:987.65,currency:'USD',exchangeRate:89500,cashierName:'Unverified Operator',date:new Date().toISOString(),refunded:false});});
 const view=render(<ReportsPage/>);fireEvent.change(view.getByRole('combobox',{name:'Reporting scope'}),{target:{value:'verified'}});expect(view.queryByText('Unverified Operator')).toBeNull();expect(view.queryByText('$987.65')).toBeNull();
 fireEvent.click(view.getByRole('button',{name:'monthly'}));expect(view.container.querySelector('input[type=month]')).not.toBeNull();fireEvent.click(view.getByRole('button',{name:'Date Range'}));expect(view.container.querySelectorAll('input[type=date]')).toHaveLength(2);
});
it('supplier metadata dialog does not allow deleting receipts or changing quantities and prices',()=>{
 const view=render(<SalesmenPage/>);expect(view.getByTitle('Delete')).toBeDisabled();fireEvent.click(view.getByTitle('Edit'));expect(view.getByRole('dialog')).toBeInTheDocument();for(const input of view.getAllByRole('spinbutton'))expect(input).toBeDisabled();fireEvent.click(view.getByRole('button',{name:'Cancel'}));expect(view.queryByRole('dialog')).toBeNull();expect(getInventoryEntries()).toHaveLength(1);
});
