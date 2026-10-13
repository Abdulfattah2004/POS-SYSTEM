import { errorMessage } from './errorMessage';

export type AssociationFailureStage = 'cloud-authorization' | 'local-save' | 'cloud-synchronization';
export interface AssociationFailureDetails { category: string; guidance: string }

// This is a recovery requirement, not a cloud authorization or quota failure.
// Keep the original guard and expose its counts without modifying any record.
export class LegacyBranchRecoveryRequiredError extends Error {
  readonly code = 'LEGACY_BRANCH_RECOVERY_REQUIRED';
  constructor(readonly counts: { products: number; entries: number; sales: number; refunds: number }) {
    super('Original inventory and history remain unassigned. Preserve a backup and complete reviewed branch recovery before selecting this branch.');
  }
}

export function associationFailureDetails(error: unknown, stage: AssociationFailureStage): AssociationFailureDetails {
  const message = errorMessage(error, '').toLowerCase();
  const value = error && typeof error === 'object' ? error as Record<string, unknown> : {};
  const cause = value.cause && typeof value.cause === 'object' ? value.cause as Record<string, unknown> : {};
  const code = String(value.code ?? cause.code ?? '');
  const status = Number(value.status ?? cause.status);
  if (error instanceof LegacyBranchRecoveryRequiredError) {
    const { products, entries, sales, refunds } = error.counts;
    return { category: 'Reviewed local branch recovery required', guidance: `${products.toLocaleString('en-US')} products, ${entries.toLocaleString('en-US')} inventory entries, ${sales.toLocaleString('en-US')} sales and ${refunds.toLocaleString('en-US')} refunds remain unassigned. Save does not attach these records. Use Offline backup and recovery below to export a verified backup and review historical branch ownership before any separately confirmed recovery. This failed save did not upload historical transactions.` };
  }
  if (message.includes('administrator authorization')) return { category: 'Local POS administrator required', guidance: 'Log in with an existing local administrator account. Supabase owner sign-in does not grant local administrator permissions.' };
  if (value.uncertainCommit === true) return { category: 'Local save acknowledgement uncertain', guidance: 'Do not switch to another branch. Reopen and check the saved association before retrying the same selection; retain the original database and backup.' };
  if (value.name === 'QuotaExceededError' || /quota|persistent cloud sign-in storage|cloud sign-in could not be saved/.test(message)) return { category: 'Local storage failure', guidance: 'Check available disk space and use the quota-safe desktop update. Do not clear localStorage or delete history. No cloud permission change can fix local storage capacity.' };
  if (value.name === 'TimeoutError' || value.name === 'AbortError' || /failed to fetch|fetch failed|network|timed? out|timeout|load failed/.test(message)) return { category: 'Cloud network failure', guidance: 'Check connectivity and retry when online. The previously saved local branch and offline records remain available.' };
  if ([401, 403].includes(status) || ['42501', 'PGRST301', 'PGRST302', 'session_expired', 'refresh_token_not_found'].includes(code) || /owner session|owner account|sign in to the supabase|jwt|row.level security|permission denied|not authorized/.test(message)) return { category: 'Supabase authorization required', guidance: 'A local administrator must reconnect the authorized owner of this existing business. Branches are validated by their IDs and business ownership, not by matching their names.' };
  if (stage === 'local-save') return { category: 'Local database save failed', guidance: 'Retain the original SQLite database and recovery backup. Resolve the reported database error before retrying; existing history must not be reset.' };
  return { category: 'Cloud request failed', guidance: 'Review the reported cloud error before retrying. A failed cloud refresh does not undo an already saved local association.' };
}
