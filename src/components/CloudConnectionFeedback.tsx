import { useSyncExternalStore } from 'react';
import { getCloudConnectionIssue, subscribeCloudConnection } from '@/lib/cloudConnectionStatus';

export default function CloudConnectionFeedback() {
  const issue = useSyncExternalStore(subscribeCloudConnection, getCloudConnectionIssue);
  return issue ? <p role="status" className="text-xs text-muted-foreground mt-2">{issue}</p> : null;
}
