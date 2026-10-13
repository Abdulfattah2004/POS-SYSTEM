import {afterEach,beforeEach,expect,it,vi} from 'vitest';
const native=vi.hoisted(()=>({enabled:false,invoke:vi.fn()}));
vi.mock('@tauri-apps/api/core',()=>({isTauri:()=>native.enabled,invoke:native.invoke}));
import {initializeStore} from './store';
import {addUser,login} from './localAuth';
import {getLocalState,resetLocalDatabaseForTests,type LocalState} from './localDatabase';
import {setInventoryAssociation} from './inventorySync';
const association={businessId:'daily',branchId:'palma',businessName:'Daily Supermarket',branchName:'palma',ownerUserId:'owner'};
let stored:LocalState;
beforeEach(async()=>{
  native.enabled=false;vi.resetAllMocks();localStorage.clear();await resetLocalDatabaseForTests();await initializeStore();
  await addUser({username:'admin',name:'Admin',password:'synthetic-native-readback',role:'admin'},true);await login('admin','synthetic-native-readback');
  stored=getLocalState();native.enabled=true;
});
afterEach(()=>{native.enabled=false;vi.restoreAllMocks();});
it('reads through native IPC after the atomic SQLite commit before confirming association success',async()=>{
  native.invoke.mockImplementation(async(command,args)=>{
    if(command==='read_pos_state')return structuredClone(stored);
    if(command==='commit_pos_state'){expect(args.expectedRevision).toBe(stored.revision);stored=structuredClone(args.document);return true;}
    throw new Error('Unexpected native command');
  });
  await setInventoryAssociation(association);
  expect(stored.association).toEqual(association);expect(getLocalState().association).toEqual(association);
  expect(native.invoke.mock.calls.map(([name])=>name)).toEqual(['read_pos_state','commit_pos_state','read_pos_state']);
});
it.each(['missing','unreadable','not-persisted'])('does not report success when native durable readback is %s',async mode=>{
  let committed=false;
  native.invoke.mockImplementation(async(command,args)=>{
    if(command==='read_pos_state'){
      if(committed&&mode==='missing')return null;
      if(committed&&mode==='unreadable')throw new Error('Cannot read durable local state');
      return structuredClone(stored);
    }
    if(command==='commit_pos_state'){committed=true;if(mode!=='not-persisted')stored=structuredClone(args.document);return true;}
    throw new Error('Unexpected command');
  });
  await expect(setInventoryAssociation(association)).rejects.toMatchObject({uncertainCommit:true});
});
