import { expect, it } from 'vitest';
import { errorMessage } from './errorMessage';
it.each([new Error('Native denial'), 'Native denial', {message:'Native denial',code:'42501'}])('preserves native/string/Supabase error diagnostics', error => {
  expect(errorMessage(error,'Fallback')).toBe('Native denial');
});
it.each([null, undefined, {}, '', {message:42}])('uses a meaningful fallback for unknown errors', error => {
  expect(errorMessage(error,'Reconnect the authorized owner.')).toBe('Reconnect the authorized owner.');
});
