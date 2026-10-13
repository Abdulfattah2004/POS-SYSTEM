import { isUnsafeClientKey } from './clientKey';
export { isUnsafeClientKey } from './clientKey';
import { createClient } from '@supabase/supabase-js';
import { createAuthStorage } from './authStorage';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL?.trim();
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY?.trim();

if (supabaseAnonKey && isUnsafeClientKey(supabaseAnonKey)) throw new Error('A secret Supabase key cannot be used in the POS client.');

export const supabaseClient = supabaseUrl && supabaseAnonKey
  ? createClient(supabaseUrl, supabaseAnonKey, {
      global: {
        fetch: (input, init) => fetch(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000) }),
      },
      auth: {
        autoRefreshToken: true,
        detectSessionInUrl: false,
        persistSession: true,
        storage: createAuthStorage(),
      },
    })
  : null;

export const isSupabaseConfigured = Boolean(supabaseClient);
