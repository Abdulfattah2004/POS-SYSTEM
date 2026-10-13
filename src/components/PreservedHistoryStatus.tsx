import type { LocalState } from '@/lib/localDatabase';
import { visibleBranch } from '@/lib/localDatabase';

export default function PreservedHistoryStatus({ state }: { state: LocalState }) {
  const historical = visibleBranch(state).sales.filter(sale => sale.legacy).length;
  const pending = state.outbox.filter(operation => operation.businessId === (state.association?.businessId ?? null) && operation.branchId === (state.association?.branchId ?? null));
  const conflict = pending.find(operation => operation.blocked || operation.quarantined);
  const error = pending.find(operation => operation.lastError)?.lastError;
  return <>
    {historical > 0 && <div role="status" className="p-3 bg-warning/10 text-sm">{historical} historical sales remain preserved in Receipts and backups. Their financial totals and refunds require a separate historical review. New verified sales and refunds are available.</div>}
    {pending.length > 0 && <div role={conflict ? 'alert' : 'status'} className="p-3 bg-warning/10 text-sm">
      {pending.length} changes saved locally, awaiting cloud confirmation. {error}
      {conflict && <><br />Unresolved cloud conflicts require an administrator; original transaction IDs and local records are retained.</>}
    </div>}
    {state.recovery.length > 0 && <details className="p-3 bg-warning/10 text-sm"><summary>Preserved upgrade and synchronization notes</summary><ul className="mt-2 list-disc pl-5">{state.recovery.map((note, index) => <li key={index}>{note}</li>)}</ul></details>}
  </>;
}
