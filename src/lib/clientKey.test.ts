import { expect,it } from 'vitest';
import { assertSafeBuildEnvironment, isUnsafeClientKey } from './clientKey';
it('normalizes keys and rejects every non-anonymous JWT or opaque client credential',()=>{
 for(const role of ['authenticated','service_role','supabase_admin','postgres']) {
   const token='test.'+btoa(JSON.stringify({role}))+'.test';
   expect(isUnsafeClientKey(token)).toBe(true);
   expect(()=>assertSafeBuildEnvironment({VITE_SUPABASE_ANON_KEY:token})).toThrow('Privileged');
 }
 expect(isUnsafeClientKey('opaque-secret')).toBe(true);
 expect(isUnsafeClientKey('broken.jwt.key')).toBe(true);
 expect(isUnsafeClientKey('  sb_publishable_synthetic_fixture  ')).toBe(false);
 expect(isUnsafeClientKey('test.'+btoa(JSON.stringify({role:'anon'}))+'.test')).toBe(false);
});
it('blocks whitespace-padded secret keys during build before runtime trimming can expose them',()=>{
 expect(()=>assertSafeBuildEnvironment({VITE_SUPABASE_ANON_KEY:'  sb_secret_synthetic_fixture  '})).toThrow('Privileged');
});
it('rejects secret credentials before Vite can generate client assets',()=>{
 expect(()=>assertSafeBuildEnvironment({VITE_SUPABASE_ANON_KEY:'sb_secret_synthetic_fixture'})).toThrow('Privileged');
 expect(()=>assertSafeBuildEnvironment({VITE_SERVICE_ROLE_KEY:'synthetic_fixture'})).toThrow('Privileged');
 expect(()=>assertSafeBuildEnvironment({VITE_SUPABASE_ANON_KEY:'sb_publishable_synthetic_fixture'})).not.toThrow();
});
