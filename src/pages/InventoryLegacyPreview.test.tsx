import {render,screen} from '@testing-library/react';
import {beforeEach,expect,it,vi} from 'vitest';
const mock=vi.hoisted(()=>({products:[{id:'branch-1',name:'Branch item',barcode:'b-1',stockQuantity:2,purchasePrice:1,salePrice:2,isActive:true}],legacy:{sourceId:'legacy',sourcePath:'%APPDATA%\\com.dailys.pos\\pos.db',fingerprint:'source-fingerprint',productCount:243,stockQuantitySum:781,products:[{id:'legacy-1',name:'Original item',barcode:'l-1',stockQuantity:7,purchasePrice:1,salePrice:3,isActive:true}]}}));
vi.mock('@/contexts/AuthContext',()=>({useAuth:()=>({isAdmin:false})}));
vi.mock('@/lib/store',()=>({getProducts:()=>mock.products,updateProduct:vi.fn(),deleteProduct:vi.fn()}));
vi.mock('@/lib/localDatabase',()=>({getLegacyInventoryDiscoveryError:()=>null,getLegacyInventoryReadView:()=>mock.legacy,getLocalState:()=>({association:{businessId:'biz',branchId:'manar',branchName:'manar'}}),inventoryOwnershipVerified:()=>false,originalBelongsToSelectedBranch:()=>false,visibleBranch:()=>({products:mock.products})}));
import InventoryPage from './InventoryPage';

beforeEach(()=>vi.clearAllMocks());
it('shows the original legacy inventory as a separate read-only list even when the selected branch has products',()=>{
  render(<InventoryPage/>);
  expect(screen.getByRole('heading',{name:'Inventory (1)'})).toBeInTheDocument();
  expect(screen.getByText('Branch item')).toBeInTheDocument();
  expect(screen.getByRole('region',{name:'Unassigned legacy inventory preview'})).toHaveTextContent('243 original products');
  expect(screen.getByText('Original item')).toBeInTheDocument();
  expect(screen.getByRole('heading',{name:/not active in this branch/})).toBeInTheDocument();
  expect(screen.queryByRole('button',{name:'Edit Original item'})).toBeNull();
});
