import { loadEnv } from 'vite';
import {validateReleasePolicy} from './release-policy.mjs';
const env = loadEnv('production', process.cwd(), 'VITE_');
const policy=validateReleasePolicy(env,process.env.SWIFT_TILL_DEPLOYMENT_EVIDENCE);
console.log(`Release target verified; production synchronization ${policy.synchronization?'enabled after documented verification':'disabled'}. Credential validation runs in Vite before bundling.`);
