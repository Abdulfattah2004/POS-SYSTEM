import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mock = vi.hoisted(()=>({
  association:{businessId:'business',branchId:'branch',ownerUserId:'owner',businessName:'Daily Supermarket',branchName:'Main Branch'},
  options:[{id:'business',name:'Daily Supermarket',branches:[{id:'branch',name:'Main Branch'}]}],
  owner:vi.fn(),optionsForOwner:vi.fn(),save:vi.fn(),refresh:vi.fn(),sync:vi.fn(),enabled:vi.fn(),bind:vi.fn(),backup:vi.fn(),recover:vi.fn(),activate:vi.fn(),hasHistory:false,
}));
vi.mock('@/lib/store',()=>({getExchangeRate:()=>89500,setExchangeRate:vi.fn(),getAllowNegativeStock:()=>true,setAllowNegativeStock:vi.fn(),getUsers:()=>[],getCurrentUser:()=>({role:'admin'}),addUser:vi.fn(),deleteUser:vi.fn()}));
vi.mock('@/lib/localDatabase',()=>({inventoryOwnershipVerified:()=>false,originalRecoveryPending:()=>mock.hasHistory,getLocalState:()=>({association:mock.association,recovery:[],branches:{unassigned:{products:mock.hasHistory?Array(243).fill({}):[],sales:mock.hasHistory?Array(22220).fill({legacy:true}):[],entries:[],refunds:[]}}})}));
vi.mock('@/lib/inventoryActivation',()=>({activateVerifiedBranchInventory:mock.activate}));
vi.mock('@/lib/recovery',()=>({exportNativeRecoveryBackup:mock.backup,recoverLegacyBranch:mock.recover,restoreRecoveryBackup:vi.fn()}));
vi.mock('@/components/PreservedHistoryStatus',()=>({default:()=>null}));
vi.mock('@/lib/supabase',()=>({isSupabaseConfigured:true}));
vi.mock('@/lib/inventorySync',()=>({
  cloudSynchronizationEnabled:mock.enabled,bindUnassignedInventoryOperations:mock.bind,
  getAuthenticatedOwnerUserId:mock.owner,getCurrentOwnerBusinessBranches:mock.optionsForOwner,
  getInventoryAssociation:()=>mock.association,getPendingInventoryOperations:()=>[],
  loadInventoryFromSupabase:mock.refresh,setInventoryAssociation:mock.save,signInSupabaseOwner:vi.fn(),
  signOutSupabaseOwner:vi.fn(),syncPendingInventory:mock.sync,retryInventoryOperations:vi.fn(),
}));
import SettingsPage from './SettingsPage';
beforeEach(()=>{
  vi.resetAllMocks();mock.hasHistory=false;mock.owner.mockResolvedValue('owner');mock.optionsForOwner.mockResolvedValue(mock.options);
  mock.save.mockResolvedValue(undefined);mock.refresh.mockResolvedValue(undefined);mock.sync.mockResolvedValue([]);mock.enabled.mockReturnValue(true);
});
afterEach(cleanup);
async function open(){render(<SettingsPage/>);await waitFor(()=>expect(screen.getByRole('combobox',{name:'Supabase business'})).toHaveValue('business'));}
function save(){fireEvent.click(screen.getByRole('button',{name:'Save Business and Branch'}));}
it('saves an authorized association independently without cloud refresh or queue binding',async()=>{
  await open();save();await screen.findByText('Business and branch saved locally. Cloud synchronization handles only verified operations for the selected branch.');
  expect(mock.save).toHaveBeenCalledWith(mock.association);expect(mock.refresh).not.toHaveBeenCalled();expect(mock.bind).not.toHaveBeenCalled();
});
it('cloud snapshot failure cannot prevent a connection-only save',async()=>{
  mock.refresh.mockRejectedValue('Existing financial records cannot be edited or removed');
  await open();save();await screen.findByText('Business and branch saved locally. Cloud synchronization handles only verified operations for the selected branch.');
  expect(mock.refresh).not.toHaveBeenCalled();expect(mock.sync).not.toHaveBeenCalled();
  expect(mock.save).toHaveBeenCalledTimes(1);
});
it('retains meaningful plain-object Supabase authentication errors and does not save',async()=>{
  mock.owner.mockRejectedValue({message:'Owner session expired. Reconnect Supabase.',code:'session_expired'});
  await open();save();await screen.findByRole('alert');expect(screen.getByRole('alert')).toHaveTextContent('were not saved: Owner session expired');expect(mock.save).not.toHaveBeenCalled();
});
it('denies a foreign business or branch rather than using cached selection as authorization',async()=>{
  mock.optionsForOwner.mockResolvedValueOnce(mock.options).mockResolvedValue([]);
  await open();save();await screen.findByRole('alert');expect(screen.getByRole('alert')).toHaveTextContent('current Supabase owner session cannot access');expect(mock.save).not.toHaveBeenCalled();
});
it('denies a cached branch that now belongs to a different business even when both businesses are listed',async()=>{
  mock.optionsForOwner.mockResolvedValueOnce(mock.options).mockResolvedValue([
    {id:'business',name:'Daily Supermarket',branches:[]},
    {id:'other-business',name:'Other business',branches:[{id:'branch',name:'Main Branch'}]},
  ]);
  await open();save();expect(await screen.findByRole('alert')).toHaveTextContent('current Supabase owner session cannot access');
  expect(mock.save).not.toHaveBeenCalled();expect(mock.sync).not.toHaveBeenCalled();
});
it('saves fresh authorized branch labels by ID even when cached names differ in case',async()=>{
  mock.optionsForOwner.mockResolvedValueOnce([{id:'business',name:'Daily Supermarket',branches:[{id:'branch',name:'PALMA'}]}]).mockResolvedValue([{id:'business',name:'Daily Supermarket',branches:[{id:'branch',name:'palma'}]}]);
  await open();save();await screen.findByText('Business and branch saved locally. Cloud synchronization handles only verified operations for the selected branch.');
  expect(mock.save).toHaveBeenCalledWith({...mock.association,branchName:'palma'});
});
it('rejects an owner-session change during fresh branch authorization without persisting or synchronizing',async()=>{
  mock.owner.mockResolvedValueOnce('owner').mockResolvedValueOnce('different-owner');
  await open();save();expect(await screen.findByRole('alert')).toHaveTextContent('owner session changed during authorization');
  expect(mock.save).not.toHaveBeenCalled();expect(mock.sync).not.toHaveBeenCalled();expect(mock.refresh).not.toHaveBeenCalled();
});
it('saves the connection while separately reporting unassigned history and paused operations',async()=>{
  mock.hasHistory=true;
  await open();save();await screen.findByText('Business and branch saved locally. Historical records remain unchanged; checkout, inventory changes and cloud synchronization are paused until current inventory ownership is verified. Historical sales recovery is not required.');
  const status=screen.getByLabelText('Supabase connection status');
  expect(status).toHaveTextContent('Supabase connection: Saved');
  expect(status).toHaveTextContent('Historical records: Unassigned (243 products; 22,220 sales)');
  expect(status).toHaveTextContent('Cloud synchronization: Paused');
  expect(mock.bind).not.toHaveBeenCalled();expect(mock.sync).not.toHaveBeenCalled();expect(mock.refresh).not.toHaveBeenCalled();
});
it.each([
  [new TypeError('Failed to fetch'),'Cloud network failure'],
  [{status:403,message:'Permission denied'},'Supabase authorization required'],
])('explains cloud verification failures before any local write: %j',async(error,category)=>{
  mock.owner.mockRejectedValue(error);await open();save();await screen.findByRole('alert');
  expect(screen.getByLabelText('Connection failure details')).toHaveTextContent(category);expect(mock.save).not.toHaveBeenCalled();
});
it.each([
  [new DOMException('Storage full','QuotaExceededError'),'Local storage failure'],
  ['SQLITE_BUSY: database is locked','Local database save failed'],
])('explains local save failures without starting cloud synchronization: %j',async(error,category)=>{
  mock.save.mockRejectedValue(error);await open();save();await screen.findByRole('alert');
  expect(screen.getByLabelText('Connection failure details')).toHaveTextContent(category);expect(mock.sync).not.toHaveBeenCalled();
});
it('does not claim an uncertain SQLite acknowledgement means the selection was definitely not saved',async()=>{
  mock.save.mockRejectedValue(Object.assign(new Error('Local commit confirmation was lost.'),{uncertainCommit:true}));
  await open();save();const alert=await screen.findByRole('alert');
  expect(alert).toHaveTextContent('save could not be confirmed');expect(alert).not.toHaveTextContent('were not saved');
  expect(screen.getByLabelText('Connection failure details')).toHaveTextContent('Local save acknowledgement uncertain');
  expect(mock.sync).not.toHaveBeenCalled();expect(mock.refresh).not.toHaveBeenCalled();
});
it('preserves local administrator denial and leaves the saved association unchanged',async()=>{
  mock.save.mockRejectedValue('Administrator authorization required');await open();save();await screen.findByRole('alert');
  expect(screen.getByRole('alert')).toHaveTextContent('were not saved: Administrator authorization required');expect(mock.refresh).not.toHaveBeenCalled();
});
it('denies saving without a current owner session',async()=>{
  mock.owner.mockResolvedValue(null);await open();save();await screen.findByRole('alert');expect(screen.getByRole('alert')).toHaveTextContent('Sign in to the Supabase business owner');expect(mock.save).not.toHaveBeenCalled();
});
it('serializes rapid saves and disables selectors and cloud actions while saving',async()=>{
  let finish!:()=>void;mock.save.mockImplementation(()=>new Promise<void>(resolve=>{finish=resolve;}));
  await open();save();fireEvent.click(screen.getByRole('button',{name:/Saving business and branch/}));
  await waitFor(()=>expect(mock.save).toHaveBeenCalledTimes(1));expect(screen.getByRole('combobox',{name:'Supabase branch'})).toBeDisabled();
  finish();await screen.findByText('Business and branch saved locally. Cloud synchronization handles only verified operations for the selected branch.');
  expect(mock.save).toHaveBeenCalledTimes(1);expect(mock.refresh).not.toHaveBeenCalled();
});
it('saving an association does not activate synchronization when the build has it disabled',async()=>{
  mock.enabled.mockReturnValue(false);await open();save();await screen.findByText('Business and branch saved locally. Cloud synchronization remains disabled.');expect(mock.sync).not.toHaveBeenCalled();expect(mock.refresh).not.toHaveBeenCalled();
});
it('reports a verified native backup path instead of an unconfirmed browser download',async()=>{
  mock.backup.mockResolvedValue({id:'export-fixture',directory:'C:\\Synthetic Backups\\export-fixture',sha256:'a'.repeat(64)});
  await open();fireEvent.click(screen.getByRole('button',{name:'Export recovery backup'}));
  const confirmation=await screen.findByText(/Verified SQLite backup saved to/);expect(confirmation).toHaveAttribute('role','status');expect(confirmation).toHaveTextContent('Synthetic Backups');
  expect(mock.backup).toHaveBeenCalledTimes(1);
});
it('shows native backup failures without reporting success',async()=>{
  mock.backup.mockRejectedValue(new Error('Cannot write recovery metadata'));
  await open();fireEvent.click(screen.getByRole('button',{name:'Export recovery backup'}));
  expect(await screen.findByRole('alert')).toHaveTextContent('Cannot write recovery metadata');
  expect(screen.queryByText(/Verified SQLite backup saved/)).toBeNull();
});

it('offers inventory-only verification after backup without invoking historical recovery',async()=>{
 mock.hasHistory=true;mock.backup.mockResolvedValue({id:'export-fixture',directory:'Synthetic backup',sha256:'a'.repeat(64)});mock.activate.mockResolvedValue(undefined);
 await open();fireEvent.click(screen.getByRole('button',{name:'Export recovery backup'}));await screen.findByText(/Verified SQLite backup saved/);
 fireEvent.change(screen.getByLabelText('Confirm current inventory branch ownership'),{target:{value:'Daily Supermarket / Main Branch'}});
 expect(screen.getByRole('button',{name:'Attach preserved records to selected branch'})).toBeDisabled();
 fireEvent.click(screen.getByRole('button',{name:'Verify and activate current inventory only'}));await screen.findByText(/Current inventory verified for the saved branch/);
 expect(mock.activate).toHaveBeenCalledWith(expect.objectContaining({id:'export-fixture'}),'Daily Supermarket / Main Branch');expect(mock.recover).not.toHaveBeenCalled();expect(mock.save).not.toHaveBeenCalled();
});
it('displays baseline mismatch without claiming inventory activation or historical recovery',async()=>{
 mock.hasHistory=true;mock.backup.mockResolvedValue({id:'export-fixture',directory:'Synthetic backup',sha256:'a'.repeat(64)});mock.activate.mockRejectedValue(new Error('Cloud balances differ; reconcile before activation'));
 await open();fireEvent.click(screen.getByRole('button',{name:'Export recovery backup'}));await screen.findByText(/Verified SQLite backup saved/);fireEvent.change(screen.getByLabelText('Confirm current inventory branch ownership'),{target:{value:'Daily Supermarket / Main Branch'}});fireEvent.click(screen.getByRole('button',{name:'Verify and activate current inventory only'}));await screen.findByText('Cloud balances differ; reconcile before activation');expect(screen.queryByText(/Current inventory verified for the saved branch/)).not.toBeInTheDocument();expect(mock.recover).not.toHaveBeenCalled();
});
