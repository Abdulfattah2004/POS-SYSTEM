let issue: string | null = null;
const listeners = new Set<() => void>();
export const getCloudConnectionIssue = () => issue;
export const subscribeCloudConnection = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};
export function setCloudConnectionIssue(value: string | null) {
  if (issue === value) return;
  issue = value;
  listeners.forEach(listener => listener());
}
export const ownerReconnectRequired = 'Supabase owner reconnection is required when online. An administrator must reconnect in Settings. The saved business and branch have not changed.';
