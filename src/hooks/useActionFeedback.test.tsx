import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { useActionFeedback } from './useActionFeedback';
import { getNotices } from '@/lib/notifications';
function Action() {
  const { toast, feedback } = useActionFeedback();
  return <form aria-label="Checkout"><button type="button" onClick={() => toast.error('Checkout was not saved')}>Checkout</button>{feedback}</form>;
}
afterEach(cleanup);
it('keeps failures next to the action and in diagnostics without a global banner', () => {
  const view = render(<Action />);
  fireEvent.click(view.getByRole('button'));
  expect(view.getByRole('form')).toContainElement(view.getByRole('alert'));
  expect(view.getByRole('alert')).toHaveTextContent('Checkout was not saved');
  expect(view.queryByLabelText('Application messages')).toBeNull();
  expect(getNotices().some(notice => notice.message === 'Checkout was not saved')).toBe(true);
  view.unmount();
  expect(render(<Action />).queryByRole('alert')).toBeNull();
});
