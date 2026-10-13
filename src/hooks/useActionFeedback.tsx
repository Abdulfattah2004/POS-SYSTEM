import { useMemo, useState } from 'react';
import { toast as diagnostics } from '@/lib/notifications';

// Feedback belongs to the mounted action/page, never the application header.
// Existing diagnostic notices remain available internally without a global UI.
export function useActionFeedback() {
  const [notice, setNotice] = useState<{ kind: 'error' | 'success' | 'info'; message: string } | null>(null);
  const toast = useMemo(() => Object.fromEntries(
    (['error', 'success', 'info'] as const).map(kind => [kind, (message: string) => {
      diagnostics[kind](message);
      setNotice({ kind, message: String(message) });
    }]),
  ) as typeof diagnostics, []);
  const feedback = notice ? <p role={notice.kind === 'error' ? 'alert' : 'status'}
    className={`text-sm mt-2 ${notice.kind === 'error' ? 'text-destructive' : 'text-muted-foreground'}`}>{notice.message}</p> : null;
  return { toast, feedback };
}
