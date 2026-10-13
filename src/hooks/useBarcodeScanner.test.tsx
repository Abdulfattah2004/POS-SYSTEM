import { fireEvent, render, cleanup } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useBarcodeScanner } from './useBarcodeScanner';
afterEach(cleanup);
function Scanner({ scan }: { scan: (value: string) => void }) {
  useBarcodeScanner(scan);
  return <input data-barcode-input="true" onKeyDown={event => { if (event.key === 'Enter') scan('123'); }} />;
}
it('focused barcode input processes Enter exactly once', () => {
  const scan = vi.fn();
  const { getByRole } = render(<Scanner scan={scan} />);
  const input = getByRole('textbox');
  for (const key of ['1', '2', '3', 'Enter']) fireEvent.keyDown(input, { key });
  expect(scan).toHaveBeenCalledTimes(1);
});
it('scanner works outside inputs and ignores editable fields', () => {
  const scan = vi.fn();
  render(<Scanner scan={scan} />);
  for (const key of ['1', '2', '3', 'Enter']) fireEvent.keyDown(document.body, { key });
  expect(scan).toHaveBeenCalledWith('123');
  expect(scan).toHaveBeenCalledTimes(1);
});
