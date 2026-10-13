import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

function isUnsafeClientKey(key) {
  if (key.startsWith('sb_publishable_')) return false;
  try {
    const parts = key.split('.');
    return parts.length !== 3 || JSON.parse(Buffer.from(parts[1], 'base64url').toString()).role !== 'anon';
  } catch {
    return true;
  }
}

const env = process.env;
assert.ok(env.GITHUB_REF_NAME?.startsWith('ci/windows-sync-candidate-'), 'Candidate workflow must run from its dedicated CI branch.');
assert.equal(env.VITE_SUPABASE_URL, 'https://ncbyahoyhrbmunqkisuq.supabase.co', 'Build must target the existing reviewed Supabase project.');
assert.equal(env.VITE_POS_SYNC_ENABLED, 'true', 'Candidate must have synchronization explicitly enabled.');
assert.equal(env.VITE_POS_BUILD_CHANNEL, 'unverified-test-candidate', 'Candidate channel marker is required.');
assert.ok(env.VITE_SUPABASE_ANON_KEY?.trim(), 'Configure the public VITE_SUPABASE_ANON_KEY repository variable.');
assert.equal(isUnsafeClientKey(env.VITE_SUPABASE_ANON_KEY), false, 'Only a Supabase anon/publishable client key is allowed.');

for (const forbidden of ['SUPABASE_DB_PASSWORD', 'SUPABASE_SERVICE_ROLE_KEY', 'PGPASSWORD']) {
  assert.equal(Boolean(env[forbidden]), false, `${forbidden} must never be supplied to the client build job.`);
}

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
const tauri = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8'));
const cargo = readFileSync('src-tauri/Cargo.toml', 'utf8');
const cargoLock = readFileSync('src-tauri/Cargo.lock', 'utf8');
assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
assert.equal(lock.version, pkg.version);
assert.equal(lock.packages[''].version, pkg.version);
assert.equal(tauri.version, pkg.version);
assert.equal(tauri.identifier, 'com.pos.dailys');
assert.equal(tauri.bundle.windows.wix.upgradeCode.toLowerCase(), '3f4f99df-849f-5d73-9a7d-b7991d83bac5');
assert.ok(cargo.includes(`version = "${pkg.version}"`));
assert.match(cargoLock, new RegExp(`name = "app"\\r?\\nversion = "${pkg.version}"`));

console.log(JSON.stringify({
  valid: true,
  version: pkg.version,
  identifier: tauri.identifier,
  upgradeCode: tauri.bundle.windows.wix.upgradeCode,
  synchronizationEnabled: true,
  targetProjectRef: 'ncbyahoyhrbmunqkisuq',
  candidateLabel: 'UNVERIFIED TEST CANDIDATE',
  certifiedCustomerRelease: false,
  installedUpgradeVerified: false,
  secretsPassedToBuild: false,
}));
