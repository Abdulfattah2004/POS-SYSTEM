import { afterEach, expect, it, vi } from 'vitest';
import { createAuthStorage } from './authStorage';
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.resetModules(); localStorage.clear(); });
it('actual Supabase SDK restores the owner session in a new client without persisting the password or logging in again', async () => {
  localStorage.clear();vi.resetModules();
  vi.stubEnv('VITE_SUPABASE_URL','https://owner-session-fixture.invalid');
  vi.stubEnv('VITE_SUPABASE_ANON_KEY','sb_publishable_synthetic_fixture');
  const encode=(value:unknown)=>btoa(JSON.stringify(value)).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
  const accessToken=encode({alg:'HS256',typ:'JWT'})+'.'+encode({sub:'synthetic-owner',exp:Math.floor(Date.now()/1000)+3600,role:'authenticated'})+'.synthetic-signature';
  const fetch=vi.fn(async()=>new Response(JSON.stringify({access_token:accessToken,refresh_token:'synthetic-refresh-token',expires_in:3600,token_type:'bearer',user:{id:'synthetic-owner',aud:'authenticated',role:'authenticated'}}),{status:200,headers:{'Content-Type':'application/json'}}));
  vi.stubGlobal('fetch',fetch);
  const first=(await import('./supabase')).supabaseClient!;
  localStorage.setItem('pos_sales','retained historical sales');
  const fullStorage=vi.spyOn(Storage.prototype,'setItem').mockImplementation(()=>{throw new DOMException('Full','QuotaExceededError');});
  try {
    expect((await first.auth.signInWithPassword({email:'synthetic@example.invalid',password:'password-never-persisted'})).error).toBeNull();
    await first.auth.stopAutoRefresh();
    expect(JSON.stringify(localStorage)).not.toContain('password-never-persisted');
    expect(await createAuthStorage().getItem('sb-owner-session-fixture-auth-token')).toContain('synthetic-refresh-token');
    expect(Object.values(localStorage).join('')).not.toContain('synthetic-refresh-token');
    expect(localStorage.getItem('pos_sales')).toBe('retained historical sales');
    expect(fullStorage).not.toHaveBeenCalled();
    const calls=fetch.mock.calls.length;vi.resetModules();
    const reopened=(await import('./supabase')).supabaseClient!;
    try {
      const restored=await reopened.auth.getSession();
      expect(restored.data.session?.user.id).toBe('synthetic-owner');
      expect(restored.data.session?.access_token).toBe(accessToken);
      expect(fetch).toHaveBeenCalledTimes(calls);
    } finally { await reopened.auth.stopAutoRefresh(); }
  } finally { await first.auth.stopAutoRefresh(); fullStorage.mockRestore(); }
});
