// Tauri rejects native Result::Err(String) as a string; Supabase can reject
// plain objects. instanceof Error alone loses the actual diagnostic.
export function errorMessage(error: unknown, fallback: string): string {
  if (typeof error === 'string' && error.trim()) return error.trim();
  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string' && error.message.trim()) {
    return error.message.trim();
  }
  return fallback;
}
