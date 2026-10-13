export function isUnsafeClientKey(key: string): boolean {
  key = key.trim();
  if (key.startsWith('sb_secret_')) return true;
  if (key.split('.').length === 3) {
    try {
      const claims = JSON.parse(atob(key.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
      return claims.role !== 'anon';
    } catch { return true; }
  }
  return !key.startsWith('sb_publishable_');
}

export function assertSafeBuildEnvironment(env:Record<string,string|undefined>):void {
 for(const [name,value] of Object.entries(env)) {
  if(name.startsWith('VITE_')&&value&&(name.includes('SERVICE_ROLE')||name.includes('SECRET')||(name==='VITE_SUPABASE_ANON_KEY'&&isUnsafeClientKey(value)))) throw new Error('Privileged credentials cannot be included in a browser build.');
 }
}
