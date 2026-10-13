// This is a config-only regression test; no assets or network calls are made.
import assert from 'node:assert/strict';
import { resolveConfig } from 'vite';
const original=process.env.VITE_SUPABASE_ANON_KEY;
let refused=false;
try {
 process.env.VITE_SUPABASE_ANON_KEY='sb_secret_synthetic_test_fixture';
 try {await resolveConfig({configFile:'vite.config.ts',configLoader:'runner'},'build');}
 catch(error){assert.match(error.message,/Privileged credentials/);refused=true;}
 assert.equal(refused,true,'Vite must reject a privileged key before producing assets');
 console.log('Vite credential guard passed using a synthetic key; no assets generated.');
} finally {
 if(original===undefined)delete process.env.VITE_SUPABASE_ANON_KEY;
 else process.env.VITE_SUPABASE_ANON_KEY=original;
}
