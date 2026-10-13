import assert from 'node:assert/strict';
import fs from 'node:fs';

const file = 'src-tauri/tauri.conf.json';
const config = JSON.parse(fs.readFileSync(file, 'utf8'));
assert.equal(config.identifier, 'com.pos.dailys');
assert.equal(config.bundle.windows.wix.upgradeCode.toLowerCase(), '3f4f99df-849f-5d73-9a7d-b7991d83bac5');
config.productName = 'Swift Till UNVERIFIED TEST CANDIDATE';
config.bundle.shortDescription = 'UNVERIFIED sync-enabled test candidate';
config.bundle.longDescription = 'UNVERIFIED TEST CANDIDATE. Sync enabled. Not certified for customer installation; installed-upgrade and fresh manar verification remain required.';
fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
console.log('Candidate-only installer branding applied in the ephemeral CI checkout; application identifier and UpgradeCode unchanged.');
