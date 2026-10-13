import {activateVerifiedBranchInventory} from '@/lib/inventoryActivation';
import {discoverLegacyInventory, legacyInventorySourceKey, restoreLegacyInventoryToSelectedBranch, type LegacyInventoryPreview} from '@/lib/legacyInventoryImport';
import { exportNativeRecoveryBackup, recoverLegacyBranch, restoreRecoveryBackup, type NativeBackupReceipt } from '@/lib/recovery';
import { getLocalState, originalRecoveryPending } from '@/lib/localDatabase';
import BranchConnectionStatus from '@/components/BranchConnectionStatus';
import { useEffect, useRef, useState } from 'react';
import { errorMessage } from '@/lib/errorMessage';
import { associationFailureDetails, type AssociationFailureDetails, type AssociationFailureStage } from '@/lib/associationFailure';
import { getExchangeRate, setExchangeRate, getAllowNegativeStock, setAllowNegativeStock, getUsers, getCurrentUser, addUser, deleteUser } from '@/lib/store';
import { Settings, Trash2 } from 'lucide-react';
import { useActionFeedback } from '@/hooks/useActionFeedback';
import CloudConnectionFeedback from '@/components/CloudConnectionFeedback';
import PreservedHistoryStatus from '@/components/PreservedHistoryStatus';
import { UserRole } from '@/types/pos';
import { isSupabaseConfigured } from '@/lib/supabase';
import {
  cloudSynchronizationEnabled,
  getAuthenticatedOwnerUserId,
  getCurrentOwnerBusinessBranches,
  getInventoryAssociation,
  getPendingInventoryOperations,
  InventoryAssociation,
  BusinessBranchOption,
  loadInventoryFromSupabase,
  setInventoryAssociation,
  signInSupabaseOwner,
  signOutSupabaseOwner,
  retryInventoryOperations,
} from '@/lib/inventorySync';

export default function SettingsPage() {
  const cloudFeedback = useActionFeedback();
  const backupFeedback = useActionFeedback();
  const rateFeedback = useActionFeedback();
  const stockFeedback = useActionFeedback();
  const usersFeedback = useActionFeedback();
  const [rate, setRate] = useState(getExchangeRate().toString());
  const [newUser, setNewUser] = useState({ username: '', password: '', name: '', role: 'cashier' as UserRole });
  const [, setRefresh] = useState(0);
  const users = getUsers();
  const localAdmin=getCurrentUser()?.role==='admin';
  const [businesses, setBusinesses] = useState<BusinessBranchOption[]>([]);
  const [association, setAssociation] = useState<InventoryAssociation | null>(() => getInventoryAssociation());
  const [businessId, setBusinessId] = useState('');
  const [branchId, setBranchId] = useState('');
  const [ownerEmail, setOwnerEmail] = useState('');
  const [ownerPassword, setOwnerPassword] = useState('');
  const [pairing, setPairing] = useState(false);
  const [pairingError, setPairingError] = useState('');
  const [pairingDetails, setPairingDetails] = useState<AssociationFailureDetails | null>(null);
  const [savingAssociation, setSavingAssociation] = useState(false);
  const saveInProgress = useRef(false);
  const [associationResult, setAssociationResult] = useState<{ error: boolean; message: string; details?: AssociationFailureDetails } | null>(null);
  const [verifiedBackup, setVerifiedBackup] = useState<NativeBackupReceipt | null>(null);
  const [backupBusy, setBackupBusy] = useState(false);
  const backupInProgress = useRef(false);
  const [recoveryConfirmation, setRecoveryConfirmation] = useState('');
  const [inventoryConfirmation,setInventoryConfirmation]=useState('');
  const [legacySources,setLegacySources]=useState<LegacyInventoryPreview[]>([]);
  const [legacySourceId,setLegacySourceId]=useState('');
  const [legacyInventoryConfirmation,setLegacyInventoryConfirmation]=useState('');
  const [legacyScanError,setLegacyScanError]=useState('');
  const unassigned = getLocalState().branches?.unassigned;
  const hasUnassignedRecords = Boolean(unassigned && (unassigned.products.length || unassigned.entries.length || unassigned.sales.length || unassigned.refunds.length));
  const recoveryPending = getLocalState().legacyBranchRecovery?.reconciliationPending;
  const inventoryProof = getLocalState().inventoryActivation;
  const legacySourcesConflict=new Set(legacySources.filter(source=>source.productCount>0).map(legacyInventorySourceKey)).size>1;
  const selectedLegacySource=legacySources.find(source=>source.sourceId===legacySourceId);
  const selectedLegacyScopeConflict=Boolean(selectedLegacySource&&association&&selectedLegacySource.branchAssignments.some(scope=>scope&&!scope.startsWith('unassigned')&&(scope.includes('/')?scope!==`${association.businessId}/${association.branchId}`:scope!==association.branchId)));
  const selectedLegacyTaxConflict=Boolean(selectedLegacySource?.taxColumns.length);

  useEffect(() => {
    let mounted=true;
    void discoverLegacyInventory().then(sources=>{if(mounted){setLegacySources(sources);setLegacySourceId(current=>current||sources[0]?.sourceId||'');}}).catch(error=>{if(mounted)setLegacyScanError(errorMessage(error,'Legacy inventory scan failed; original files were not changed.'));});
    if (isSupabaseConfigured) getCurrentOwnerBusinessBranches()
      .then(options => {
        setBusinesses(options);
        const saved = getInventoryAssociation();
        const business = options.find(option => option.id === saved?.businessId) ?? options[0];
        setBusinessId(business?.id ?? '');
        setBranchId(business?.branches.find(branch => branch.id === saved?.branchId)?.id ?? business?.branches[0]?.id ?? '');
      })
      .catch(error => {
        setPairingError(errorMessage(error, 'Could not load Supabase businesses. Reconnect the authorized business owner.'));
        setPairingDetails(associationFailureDetails(error, 'cloud-authorization'));
      });
    return()=>{mounted=false;};
  }, []);

  const connectSupabaseOwner = async (event: React.FormEvent) => {
    event.preventDefault();
    setPairing(true);
    setPairingError('');
    setPairingDetails(null);
    try {
      const options = await signInSupabaseOwner(ownerEmail.trim(), ownerPassword);
      setBusinesses(options);
      const saved = getInventoryAssociation();
      const business = options.find(option => option.id === saved?.businessId) ?? options[0];
      setBusinessId(business?.id ?? '');
      setBranchId(business?.branches.find(branch => branch.id === saved?.branchId)?.id ?? business?.branches[0]?.id ?? '');
      setOwnerPassword('');
      if (options.length === 0) setPairingError('This Supabase user does not own a business visible to the current RLS policies.');
      else if (options.every(option => option.branches.length === 0)) setPairingError('No existing branches were found for this business.');
    } catch (error) {
      setPairingError(errorMessage(error, 'Supabase sign-in failed.'));
      setPairingDetails(associationFailureDetails(error, 'cloud-authorization'));
    } finally {
      setPairing(false);
    }
  };

  const saveInventoryAssociation = async () => {
    const toast = cloudFeedback.toast;
    if (saveInProgress.current) return;
    const business = businesses.find(option => option.id === businessId);
    const branch = business?.branches.find(option => option.id === branchId);
    if (!business || !branch) {
      toast.error('Select an existing business and branch');
      return;
    }

    const pending = getPendingInventoryOperations();
    const otherScopePending = pending.some(operation =>
      (operation.businessId && operation.businessId !== business.id) ||
      (operation.branchId && operation.branchId !== branch.id)
    );
    if (otherScopePending) {
      toast.error('Sync or resolve pending operations for the current branch before changing the association');
      return;
    }

    saveInProgress.current = true;
    setSavingAssociation(true);
    setAssociationResult(null);
    let saved = false;
    let failureStage: AssociationFailureStage = 'cloud-authorization';
    try {
      const ownerUserId = await getAuthenticatedOwnerUserId();
      if (!ownerUserId) {
        throw new Error('Sign in to the Supabase business owner account first. The saved local branch has not changed.');
      }
      const currentOwnerOptions = await getCurrentOwnerBusinessBranches();
      const authorizedBusiness = currentOwnerOptions.find(option => option.id === business.id);
      const authorizedBranch = authorizedBusiness?.branches.find(item => item.id === branch.id);
      if (!authorizedBusiness || !authorizedBranch) {
        throw new Error('The current Supabase owner session cannot access this business and branch. Reconnect the correct owner account.');
      }
      if (await getAuthenticatedOwnerUserId() !== ownerUserId) {
        throw new Error('The Supabase owner session changed during authorization. Reconnect the correct owner account and retry. The saved local branch has not changed.');
      }
      // IDs establish scope. Fresh authorized names avoid cached case/rename
      // differences in both saved labels and the reviewed recovery confirmation.
      setBusinesses(currentOwnerOptions);
      const nextAssociation: InventoryAssociation = {
        businessId: authorizedBusiness.id,
        branchId: authorizedBranch.id,
        businessName: authorizedBusiness.name,
        branchName: authorizedBranch.name,
        ownerUserId,
      };
      failureStage = 'local-save';
      await setInventoryAssociation(nextAssociation);
      setAssociation(nextAssociation);
      saved = true;
      // Save is connection-only. Cloud refresh and queue/recovery actions have
      // their own controls and safety checks; no historical work is inferred.
      const paused = originalRecoveryPending() || getLocalState().legacyBranchRecovery?.reconciliationPending;
      setAssociationResult({ error: false, message: paused
        ? 'Business and branch saved locally. Historical records remain unchanged; checkout, inventory changes and cloud synchronization are paused until current inventory ownership is verified. Historical sales recovery is not required.'
        : cloudSynchronizationEnabled()
        ? 'Business and branch saved locally. Cloud synchronization handles only verified operations for the selected branch.'
        : 'Business and branch saved locally. Cloud synchronization remains disabled.' });
    } catch (error) {
      const reason = errorMessage(error, 'The operation failed without an error description. Reconnect the authorized business owner and retry.');
      const message = saved
        ? `Business and branch were saved locally. Cloud synchronization paused: ${reason}`
        : error && typeof error === 'object' && 'uncertainCommit' in error && error.uncertainCommit === true
        ? `Business and branch save could not be confirmed: ${reason}`
        : `Business and branch were not saved: ${reason}`;
      setAssociationResult({ error: true, message, details: associationFailureDetails(error, failureStage) });
    } finally {
      saveInProgress.current = false;
      setSavingAssociation(false);
    }
  };

  const retryInventorySync = async () => {
    const toast = cloudFeedback.toast;
    try {
      const confirmed = await retryInventoryOperations();
      if (getPendingInventoryOperations().length === 0 && association) {
        await loadInventoryFromSupabase();
        toast.success(`Inventory synced with Supabase (${confirmed.length} change(s) confirmed)`);
      } else {
        toast.info(`${getPendingInventoryOperations().length} inventory change(s) remain queued for Supabase`);
      }
      setRefresh(value => value + 1);
    } catch (error) {
      toast.error(errorMessage(error, 'Inventory sync retry failed'));
    }
  };

  const disconnectSupabaseOwner = async () => {
    const toast = cloudFeedback.toast;
    try {
      await signOutSupabaseOwner();
      setBusinesses([]);
      toast.info('Supabase owner session signed out; local POS login is unchanged');
    } catch (error) {
      console.error('[inventory-sync] Supabase sign-out failed.', error);
      toast.error('Could not sign out of Supabase');
    }
  };

  const exportBackup = async () => {
    const toast = backupFeedback.toast;
    if (backupInProgress.current) return;
    backupInProgress.current = true; setBackupBusy(true); setVerifiedBackup(null);
    try {
      const receipt = await exportNativeRecoveryBackup();
      setVerifiedBackup(receipt);
      toast.success(`Verified SQLite backup saved to ${receipt.directory}. SHA-256: ${receipt.sha256}`);
    } catch (error) { toast.error(errorMessage(error, 'Backup export failed. No verified backup was created.')); }
    finally { backupInProgress.current = false; setBackupBusy(false); }
  };
  const activateInventory = async () => {
    if(backupInProgress.current || !verifiedBackup)return;
    backupInProgress.current=true;setBackupBusy(true);
    try {
      await activateVerifiedBranchInventory(verifiedBackup,inventoryConfirmation);
      setRefresh(value=>value+1);
      backupFeedback.toast.success('Current inventory verified for the saved branch. New branch transactions are permitted; historical sales and queues remain unchanged and are never replayed.');
    } catch(error) {backupFeedback.toast.error(errorMessage(error,'Inventory verification failed; no inventory was activated.'));}
    finally {backupInProgress.current=false;setBackupBusy(false);}
  };
  const importLegacyInventory = async () => {
    if(backupInProgress.current||!legacySourceId)return;
    backupInProgress.current=true;setBackupBusy(true);
    try{
      const receipt=await restoreLegacyInventoryToSelectedBranch(legacySourceId,legacyInventoryConfirmation);
      setVerifiedBackup(receipt);
      const fresh=await discoverLegacyInventory();setLegacySources(fresh);setRefresh(value=>value+1);
      backupFeedback.toast.success('Verified legacy inventory is active in the selected branch. Historical sales, refunds and queues were not imported or replayed.');
    }catch(error){backupFeedback.toast.error(errorMessage(error,'Inventory restore stopped. Existing source and destination records remain preserved.'));}
    finally{backupInProgress.current=false;setBackupBusy(false);}
  };
  const attachLegacyBranch = async () => {
    if (backupInProgress.current || !verifiedBackup) return;
    backupInProgress.current = true; setBackupBusy(true);
    try {
      const business = businesses.find(option => option.id === businessId);
      const branch = business?.branches.find(option => option.id === branchId);
      const ownerUserId = await getAuthenticatedOwnerUserId();
      if (!business || !branch || !ownerUserId) throw new Error('Connect the authorized owner and select the existing business and branch first.');
      await recoverLegacyBranch({businessId:business.id,branchId:branch.id,businessName:business.name,branchName:branch.name,ownerUserId}, verifiedBackup, recoveryConfirmation);
      setAssociation(getInventoryAssociation());
      backupFeedback.toast.success('Preserved records attached locally. Synchronization remains paused until reviewed inventory and pending-operation reconciliation.');
    } catch (error) { backupFeedback.toast.error(errorMessage(error, 'Legacy recovery stopped; original records remain unchanged.')); }
    finally { backupInProgress.current = false; setBackupBusy(false); }
  };
  const saveRate = async () => {
    const toast = rateFeedback.toast;
    try {
    const num = Number(rate);
    if (num > 0) {
      await setExchangeRate(num);
      toast.success('Exchange rate updated');
    } else throw new Error('Exchange rate must be positive and finite.');
    } catch (error) { toast.error(String(error)); }
  };

  const handleAddUser = async (e: React.FormEvent) => {
    const toast = usersFeedback.toast;
    e.preventDefault();
    if (!newUser.username || !newUser.password || !newUser.name) {
      toast.error('Fill all fields');
      return;
    }
    try {
    await addUser(newUser);
    setNewUser({ username: '', password: '', name: '', role: 'cashier' });
    setRefresh(r => r + 1);
    toast.success('User added');
    } catch (error) { toast.error(String(error)); }
  };

  return (
    <div className="p-6 max-w-2xl space-y-8">
      <div className="flex items-center gap-3">
        <Settings className="text-primary" size={24} />
        <h2 className="pos-header">Settings</h2>
      </div>

      <section className="pos-card p-6 space-y-4">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h3 className="font-semibold text-foreground">Supabase Inventory Connection</h3>
            <p className="text-sm text-muted-foreground">Connection management requires both a local POS administrator and the authorized Supabase business owner. Cashiers use the saved association automatically.</p>
            <p className="text-sm text-muted-foreground mt-1">
              {association
                ? `Saved association: ${association.businessName} / ${association.branchName}`
                : 'Sign in to the POS as a local administrator, then connect the Supabase business owner account.'}
            </p>
          </div>
          {association && <span className="text-xs text-muted-foreground">{getPendingInventoryOperations().length} pending</span>}
        </div>

        {!isSupabaseConfigured ? (
          <p className="text-sm text-destructive">Supabase is not configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY for this installation.</p>
        ) : businesses.length === 0 ? (
          <form onSubmit={connectSupabaseOwner} className="grid gap-3 sm:grid-cols-2">
            <input className="pos-input" type="email" autoComplete="username" placeholder="Supabase owner email" value={ownerEmail} onChange={event => setOwnerEmail(event.target.value)} required />
            <input className="pos-input" type="password" autoComplete="current-password" placeholder="Supabase owner password" value={ownerPassword} onChange={event => setOwnerPassword(event.target.value)} required />
            <button className="pos-btn-primary sm:col-span-2" type="submit" disabled={pairing}>{pairing ? 'Connecting...' : 'Connect Supabase Owner'}</button>
          </form>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            <select aria-label="Supabase business" className="pos-input" value={businessId} disabled={savingAssociation} onChange={event => {
              const nextBusiness = businesses.find(item => item.id === event.target.value);
              setBusinessId(event.target.value);
              setBranchId(nextBusiness?.branches[0]?.id ?? '');
            }}>
              <option value="">Select business</option>
              {businesses.map(business => <option key={business.id} value={business.id}>{business.name}</option>)}
            </select>
            <select aria-label="Supabase branch" className="pos-input" value={branchId} disabled={savingAssociation} onChange={event => setBranchId(event.target.value)}>
              <option value="">Select branch</option>
              {(businesses.find(item => item.id === businessId)?.branches ?? []).map(branch => <option key={branch.id} value={branch.id}>{branch.name}</option>)}
            </select>
            <button className="pos-btn-primary" type="button" disabled={savingAssociation} onClick={() => void saveInventoryAssociation()}>{savingAssociation ? 'Saving business and branch…' : 'Save Business and Branch'}</button>
            <button className="pos-btn-secondary" type="button" disabled={savingAssociation} onClick={() => void retryInventorySync()}>Retry Inventory Sync</button>
            <button className="pos-btn-secondary" type="button" disabled={savingAssociation} onClick={() => void disconnectSupabaseOwner()}>Sign Out of Supabase</button>
          </div>
        )}
        {pairingError && <p role="alert" className="text-sm text-destructive">{pairingError}</p>}
        {pairingDetails && <p className="text-sm text-muted-foreground">{pairingDetails.category}: {pairingDetails.guidance}</p>}
        {associationResult && <p role={associationResult.error ? 'alert' : 'status'} className={`text-sm ${associationResult.error ? 'text-destructive' : 'text-muted-foreground'}`}>{associationResult.message}</p>}
        {associationResult?.details && <p aria-label="Connection failure details" className="text-sm text-muted-foreground">{associationResult.details.category}: {associationResult.details.guidance}</p>}
        <BranchConnectionStatus saveInProgress={savingAssociation} saveUnconfirmed={associationResult?.details?.category === 'Local save acknowledgement uncertain'} />
        {cloudFeedback.feedback}
        <CloudConnectionFeedback />
      </section>

      <section className="pos-card p-6 space-y-3">
        <h3 className="font-semibold">Offline backup and recovery</h3>
        <p className="text-sm text-muted-foreground">Export a verified SQLite snapshot, account password hashes, original history, settings and pending operation IDs to Documents / Swift Till Backups. Cloud tokens are excluded. Keep this private backup folder safe. JSON restore is allowed only into an empty installation.</p>
        <button type="button" className="pos-btn-secondary" disabled={backupBusy} onClick={exportBackup}>{backupBusy ? 'Verifying backup / recovery…' : 'Export recovery backup'}</button>
        <div className="space-y-3 border-t pt-4">
          <h4 className="font-medium">Restore Existing Inventory to Selected Branch</h4>
          <p className="text-sm">The POS scans the original <code>%APPDATA%\com.dailys.pos</code> files and the current Swift Till data folder read-only. It compares product IDs, barcodes, prices and stock with the selected branch before importing. The import creates a verified automatic SQLite backup. Historical sales, refunds, inventory entries, users and pending operations remain in the original database and are never imported or replayed.</p>
          {inventoryProof&&<p role="status" className="text-sm">Inventory-only activation is already recorded for {inventoryProof.businessId} / {inventoryProof.branchId}. The original source and history remain preserved. Switching branches does not move this inventory.</p>}
          {legacyScanError&&<p role="alert" className="text-sm text-destructive">{legacyScanError}</p>}
          {legacySources.length===0&&!legacyScanError&&<p role="status" className="text-sm text-muted-foreground">No legacy SQLite inventory source was found.</p>}
          {legacySourcesConflict&&<p role="alert" className="text-sm text-destructive">Existing POS databases contain different inventory baselines. Import is blocked until the source quantities are reviewed.</p>}
          {selectedLegacyScopeConflict&&<p role="alert" className="text-sm text-destructive">The source records a different branch assignment. The typed confirmation cannot override stored ownership; reviewed reconciliation is required.</p>}
          {selectedLegacyTaxConflict&&<p role="alert" className="text-sm text-destructive">This source has product tax fields ({selectedLegacySource?.taxColumns.join(', ')}) that this POS product model cannot preserve. Products remain visible in the read-only preview; import is blocked until that tax mapping is supported.</p>}
          {legacySources.length>0&&!inventoryProof&&<>
            <label className="block text-sm">Read-only source database
              <select className="pos-input w-full" value={legacySourceId} disabled={backupBusy} onChange={event=>setLegacySourceId(event.target.value)}>
                {legacySources.map(source=><option key={source.sourceId} value={source.sourceId}>{source.sourcePath} — {source.productCount} products, stock {source.stockQuantitySum}</option>)}
              </select>
            </label>
            {legacySources.filter(source=>source.sourceId===legacySourceId).map(source=><div key={source.sourceId} className="text-sm space-y-1" aria-label="Legacy inventory source preview">
              <p>SQLite integrity: {source.integrity}; products: {source.productCount} ({source.activeProductCount} active); combined stock: {source.stockQuantitySum}.</p>
              <p>Source history retained only: {source.salesCount.toLocaleString()} sales, {source.refundsCount.toLocaleString()} refunds, {source.inventoryEntryCount.toLocaleString()} inventory entries. None will be imported.</p>
              <p>Recorded branch assignment: {source.branchAssignments.join(', ')}. Source SHA-256: {source.sha256}</p>
              <p>Destination: {association?.businessName ?? 'Select business'} / {association?.branchName ?? 'Select branch'}.</p>
            </div>)}
            {localAdmin&&<>
              <label className="block text-sm">Confirm all listed current product quantities belong to the selected branch
                <input className="pos-input w-full" value={legacyInventoryConfirmation} onChange={event=>setLegacyInventoryConfirmation(event.target.value)} placeholder="Type exact Business / Branch name" />
              </label>
              <button type="button" className="pos-btn-primary" disabled={backupBusy||!legacySourceId||!association||!legacyInventoryConfirmation||legacySourcesConflict||selectedLegacyScopeConflict||selectedLegacyTaxConflict} onClick={importLegacyInventory}>{backupBusy?'Verifying backups and inventory…':'Restore Existing Inventory to Selected Branch'}</button>
            </>}
          </>}
        </div>
        {hasUnassignedRecords && !getLocalState().inventoryActivation && <div className="space-y-2">
          <h4 className="font-medium">Verify current inventory independently of historical sales</h4>
          <p className="text-sm">Save the authorized connection, export a fresh verified backup, then confirm current inventory ownership below. Activation requires an exact product-ID, barcode, price and quantity match with this authorized cloud branch. Original records and pending IDs remain preserved and unassigned. No historical sale or stock operation is uploaded. Differences require reviewed inventory reconciliation; historical sales recovery is not required.</p>
          <label className="block text-sm">Confirm current inventory branch ownership
            <input className="pos-input w-full" value={inventoryConfirmation} onChange={event=>setInventoryConfirmation(event.target.value)} placeholder="Type exact Business / Branch name" />
          </label>
          <button type="button" className="pos-btn-secondary" disabled={backupBusy || !verifiedBackup || !inventoryConfirmation || !association} onClick={activateInventory}>Verify and activate current inventory only</button>
        </div>}
        {hasUnassignedRecords && !getLocalState().inventoryActivation && <div className="space-y-2">
          <h4 className="font-medium">Optional full historical branch recovery</h4>
          <p className="text-sm">This separate historical reassignment is not required for inventory-only activation or new cash sales. Do not use it unless ownership of the entire history has been reviewed.</p>
          <p className="text-sm">Original records remain unassigned: {unassigned?.products.length} products, {unassigned?.sales.length} historical sales. Connect the authorized Supabase owner, select the existing business/branch above, then export a fresh verified backup. This local recovery requires an empty destination and never uploads historical transactions. Cloud synchronization stays paused until reconciliation.</p>
          <label className="block text-sm">Confirm historical branch ownership
            <input className="pos-input w-full" value={recoveryConfirmation} onChange={event => setRecoveryConfirmation(event.target.value)} placeholder="Type exact Business / Branch name" />
          </label>
          <button type="button" className="pos-btn-secondary" disabled={backupBusy || !verifiedBackup || !recoveryConfirmation} onClick={attachLegacyBranch}>Attach preserved records to selected branch</button>
        </div>}
        {recoveryPending && <p role="status" className="text-sm">Legacy branch recovery is recorded. Cloud synchronization is paused until inventory and original pending operations are reconciled. Historical sales are preserved locally and will not be replayed.</p>}
        <label className="block text-sm">Restore backup
          <input type="file" accept="application/json,.json" onChange={async event => {
            const file = event.target.files?.[0]; if (!file) return;
            try { await restoreRecoveryBackup(await file.text()); setAssociation(getInventoryAssociation()); backupFeedback.toast.success('Backup restored; original operation IDs retained.'); }
            catch (error) { backupFeedback.toast.error(String(error)); }
            event.target.value = '';
          }} />
        </label>
        {backupFeedback.feedback}
        <PreservedHistoryStatus state={getLocalState()} />
        <ul className="text-sm space-y-2">{getPendingInventoryOperations().filter(operation => operation.lastError).map(operation => <li key={operation.operationId}>{operation.type}: {operation.lastError} (attempt {operation.attempts})</li>)}</ul>
      </section>

      {/* Exchange Rate */}
      <div className="pos-card p-6">
        <h3 className="font-semibold text-foreground mb-3">Negative stock sales</h3>
        <label className="flex gap-3 items-center text-sm">
          <input type="checkbox" checked={getAllowNegativeStock()} disabled={cloudSynchronizationEnabled()} onChange={async event => {
            try { await setAllowNegativeStock(event.target.checked); setRefresh(value => value + 1); stockFeedback.toast.success('Stock sales policy updated'); }
            catch (error) { stockFeedback.toast.error(String(error)); }
          }} />
          Allow selling active items when stock is zero or below
        </label>
        <p className="text-xs text-muted-foreground mt-2">Sales below available stock record a negative inventory balance. Receipts and refunds increase that balance normally. When cloud synchronization is active, the approved server branch policy controls this setting.</p>
        {stockFeedback.feedback}
      </div>
      <div className="pos-card p-6">
        <h3 className="font-semibold text-foreground mb-4">Exchange Rate (USD → LBP)</h3>
        <div className="flex gap-3">
          <div className="flex items-center gap-2 flex-1">
            <span className="text-sm text-muted-foreground">1 USD =</span>
            <input type="number" className="pos-input flex-1" value={rate} onChange={e => setRate(e.target.value)} />
            <span className="text-sm text-muted-foreground">L.L</span>
          </div>
          <button onClick={saveRate} className="pos-btn-primary">Save</button>
        </div>
        {rateFeedback.feedback}
      </div>

      {/* Users */}
      <div className="pos-card p-6">
        <h3 className="font-semibold text-foreground mb-4">User Management</h3>
        <div className="mb-4">
          <table className="w-full text-sm">
            <thead>
              <tr className="pos-table-header">
                <th className="text-left py-2 px-3">Name</th>
                <th className="text-left py-2 px-3">Username</th>
                <th className="text-left py-2 px-3">Role</th>
                <th className="text-right py-2 px-3">Action</th>
              </tr>
            </thead>
            <tbody>
              {users.map(u => (
                <tr key={u.id} className="border-b border-border">
                  <td className="py-2 px-3">{u.name}</td>
                  <td className="py-2 px-3 font-mono text-xs">{u.username}</td>
                  <td className="py-2 px-3 capitalize">{u.role}</td>
                  <td className="py-2 px-3 text-right">
                    <button
                      onClick={async () => {
                        if (confirm(`Delete user "${u.name}"?`)) {
                          try {
                          await deleteUser(u.id);
                          setRefresh(r => r + 1);
                          usersFeedback.toast.success('User deleted');
                          } catch (error) { usersFeedback.toast.error(String(error)); }
                        }
                      }}
                      className="text-destructive hover:text-destructive/80 transition-colors"
                    >
                      <Trash2 size={16} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <form onSubmit={handleAddUser} className="grid grid-cols-2 gap-3">
          <input className="pos-input" placeholder="Name" value={newUser.name} onChange={e => setNewUser({ ...newUser, name: e.target.value })} />
          <input className="pos-input" placeholder="Username" value={newUser.username} onChange={e => setNewUser({ ...newUser, username: e.target.value })} />
          <input className="pos-input" placeholder="Password" type="password" value={newUser.password} onChange={e => setNewUser({ ...newUser, password: e.target.value })} />
          <select className="pos-input" value={newUser.role} onChange={e => setNewUser({ ...newUser, role: e.target.value as UserRole })}>
            <option value="cashier">Cashier</option>
            <option value="admin">Admin</option>
          </select>
          <button type="submit" className="pos-btn-primary col-span-2">Add User</button>
        </form>
        {usersFeedback.feedback}
      </div>
    </div>
  );
}
