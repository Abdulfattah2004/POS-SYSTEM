import { expect, it } from 'vitest';
import { associationFailureDetails, LegacyBranchRecoveryRequiredError } from './associationFailure';
import { CommitUncertainError } from './localDatabase';
import { readAllPages } from './pagination';

it('distinguishes legacy recovery from cloud authorization and includes exact preserved counts', () => {
  const result = associationFailureDetails(new LegacyBranchRecoveryRequiredError({products:243,entries:15,sales:22220,refunds:7}), 'local-save');
  expect(result.category).toBe('Reviewed local branch recovery required');
  expect(result.guidance).toContain('243 products, 15 inventory entries, 22,220 sales and 7 refunds');
  expect(result.guidance).toContain('Save does not attach these records');
});
it.each([
  ['Administrator authorization is required.', 'cloud-authorization', 'Local POS administrator required'],
  [{status:403,message:'Access denied'}, 'cloud-authorization', 'Supabase authorization required'],
  [{code:'session_expired',message:'Expired'}, 'cloud-authorization', 'Supabase authorization required'],
  [new TypeError('Failed to fetch'), 'cloud-authorization', 'Cloud network failure'],
  [new DOMException('Too full', 'QuotaExceededError'), 'local-save', 'Local storage failure'],
  ['SQLITE_BUSY: database is locked', 'local-save', 'Local database save failed'],
  [new CommitUncertainError(), 'local-save', 'Local save acknowledgement uncertain'],
  [{message:'Unexpected RPC contract'}, 'cloud-synchronization', 'Cloud request failed'],
] as const)('classifies %j independently of saved history', (error, stage, category) => {
  expect(associationFailureDetails(error, stage).category).toBe(category);
});
it('retains PostgREST permission codes through pagination instead of reducing every failure to a generic Error', async () => {
  const permission = {message:'Access denied',code:'42501'};
  let caught: unknown;
  try { await readAllPages(async () => ({data:null,error:permission})); } catch (error) { caught=error; }
  expect(caught).toMatchObject({message:'Access denied',cause:permission});
  expect(associationFailureDetails(caught,'cloud-authorization').category).toBe('Supabase authorization required');
});
