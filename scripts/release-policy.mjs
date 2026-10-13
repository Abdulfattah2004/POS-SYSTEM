import {readFileSync,existsSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
export function validateReleasePolicy(env,evidencePath,now=Date.now()) {
 const url=new URL(env.VITE_SUPABASE_URL||'https://unconfigured.invalid');
 if(url.origin!=='https://ncbyahoyhrbmunqkisuq.supabase.co')throw new Error('Release must target the reviewed existing Supabase project.');
 if(!env.VITE_SUPABASE_ANON_KEY?.trim())throw new Error('Release public client key is missing.');
 if(env.VITE_POS_SYNC_ENABLED!=='true')return {synchronization:false};
 if(!evidencePath)throw new Error('Synchronization release requires completed deployment verification evidence.');
 const path=resolve(evidencePath),evidence=JSON.parse(readFileSync(path,'utf8'));
 if(evidence.format!=='swift-till-deployment-verification-v1'||evidence.projectRef!=='ncbyahoyhrbmunqkisuq'||evidence.businessId!=='1593a757-910c-4e45-8dd2-26436bae0347'||evidence.branchId!=='64bb012f-4070-4ef8-87b7-a3f836e522a9'||!Number.isFinite(Date.parse(evidence.verifiedAt))||now-Date.parse(evidence.verifiedAt)>86400000||Date.parse(evidence.verifiedAt)>now)throw new Error('Deployment evidence scope or verification date is invalid.');
 for(const name of ['productionBackupRestore','closedCustomerProfileBackup','inventoryRecovery','inventoryBaseline','pendingQueueReview','rpcRlsVerification','managedAcceptance','windowsInstallerUpgrade','syncActivation']) {
  const check=evidence.checks?.[name];
  if(check?.verified!==true||typeof check.evidence!=='string'||!check.evidence||!existsSync(resolve(dirname(path),check.evidence)))throw new Error(`Deployment prerequisite is incomplete: ${name}`);
 }
 return {synchronization:true};
}
