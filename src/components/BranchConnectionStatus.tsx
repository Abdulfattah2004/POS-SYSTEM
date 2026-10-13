import {getLocalState, originalRecoveryPending, inventoryOwnershipVerified} from '@/lib/localDatabase';
import {cloudSynchronizationEnabled} from '@/lib/inventorySync';

// Operational status beside the action, not a global notification banner.
export default function BranchConnectionStatus({saveUnconfirmed=false,saveInProgress=false}:{saveUnconfirmed?:boolean;saveInProgress?:boolean}={}) {
  const state=getLocalState(), original=state.branches?.unassigned;
  const hasHistory=Boolean(original && (original.products.length || original.entries.length || original.sales.length || original.refunds.length || original.heldSales?.length));
  const paused=originalRecoveryPending(state) || state.legacyBranchRecovery?.reconciliationPending;
  return <dl aria-label="Supabase connection status" className="text-sm text-muted-foreground space-y-1">
    <div><dt className="inline font-medium">Supabase connection: </dt><dd className="inline">{saveUnconfirmed?'Save unconfirmed — reopen and verify':saveInProgress?'Verifying saved association…':state.association?'Saved':'Not saved'}</dd></div>
    <div><dt className="inline font-medium">Historical records: </dt><dd className="inline">{hasHistory?`Unassigned (${original!.products.length.toLocaleString('en-US')} products; ${original!.sales.length.toLocaleString('en-US')} sales)`:'No unassigned records'}</dd></div>
    <div><dt className="inline font-medium">Current inventory: </dt><dd className="inline">{inventoryOwnershipVerified(state)?'Verified for this branch; archived inventory remains read-only':paused?'Ownership review required before checkout':'Branch-scoped inventory'}</dd></div>
    <div><dt className="inline font-medium">Cloud synchronization: </dt><dd className="inline">{!state.association?'No saved branch':paused?'Paused pending reviewed branch attribution of current inventory; historical sales recovery is not required':!cloudSynchronizationEnabled()?'Disabled in this build':'Enabled only for verified, correctly attributed operations; owner authentication and server checks remain required'}</dd></div>
  </dl>;
}
