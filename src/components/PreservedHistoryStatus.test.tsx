import { afterEach, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import PreservedHistoryStatus from './PreservedHistoryStatus';
import { emptyBranch, type LocalState } from '@/lib/localDatabase';
const state = (): LocalState => ({ version: 2, revision: 0, association: null, branches: { unassigned: emptyBranch() }, outbox: [], recovery: ['Original records retained; historical review pending.'] });
afterEach(cleanup);
it('retains migration notes without declaring a resolved, empty queue to be a current cloud conflict', () => {
  const view = render(<PreservedHistoryStatus state={state()} />);
  expect(view.getByText('Preserved upgrade and synchronization notes')).toBeVisible();
  expect(view.queryByText(/Unresolved cloud conflicts/)).toBeNull();
  expect(view.queryByRole('alert')).toBeNull();
});
it('keeps real blocked operation errors and administrator conflict restrictions visible', () => {
  const input = state();input.outbox = [{ operationId: 'original-id', businessId: null, branchId: null, type: 'stock_delta', productId: 'product', quantityDelta: -1, blocked: true, lastError: 'Foreign scope denied' }];
  const view = render(<PreservedHistoryStatus state={input} />);
  expect(view.getByRole('alert')).toHaveTextContent('Foreign scope denied');
  expect(view.getByRole('alert')).toHaveTextContent('Unresolved cloud conflicts require an administrator');
  expect(input.outbox[0].operationId).toBe('original-id');
});
it('describes historical sales separately and does not imply refunds on new valid sales are blocked', () => {
  const input = state();input.branches.unassigned.sales = [{ id: 'original-sale', legacy: true, items: [], subtotal: 2, total: 2, currency: 'USD', exchangeRate: 89500, date: '2020-01-01', cashierName: 'Original', refunded: false }];
  const view = render(<PreservedHistoryStatus state={input} />);
  expect(view.getByRole('status')).toHaveTextContent('1 historical sales');
  expect(view.getByRole('status')).toHaveTextContent('New verified sales and refunds are available');
});
