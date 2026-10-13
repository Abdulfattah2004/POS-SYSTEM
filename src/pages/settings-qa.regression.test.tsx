import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import {render,cleanup,fireEvent,waitFor} from '@testing-library/react';
import {addUser,login} from '@/lib/localAuth';
import {initializeStore,getUsers,getExchangeRate} from '@/lib/store';
import {resetLocalDatabaseForTests,getLocalState,reloadLocalState} from '@/lib/localDatabase';
import SettingsPage from './SettingsPage';
import InlineNotifications from '@/components/InlineNotifications';
const owner=vi.hoisted(()=>({connected:false}));
vi.mock('@/lib/inventorySync',async(importOriginal)=>{
 const actual=await importOriginal<typeof import('@/lib/inventorySync')>();
 const options=[{id:'qa-business',name:'Synthetic Market',branches:[{id:'qa-branch',name:'Synthetic Branch'}]}];
 return {...actual,getCurrentOwnerBusinessBranches:vi.fn(async()=>owner.connected?options:[]),getAuthenticatedOwnerUserId:vi.fn(async()=>owner.connected?'qa-owner':null),
 signInSupabaseOwner:vi.fn(async(email,password)=>{if(password!=='owner-test-password')throw new Error('Synthetic owner credentials rejected');owner.connected=true;return options;}),
 signOutSupabaseOwner:vi.fn(async()=>{owner.connected=false;})};
});
beforeEach(async()=>{owner.connected=false;localStorage.clear();await resetLocalDatabaseForTests();await initializeStore();await addUser({username:'admin',password:'settings-test-password',name:'Admin',role:'admin'},true);await login('admin','settings-test-password');});
afterEach(()=>{cleanup();vi.restoreAllMocks();});
it('owner pairing, stable administrator reread and branch saving retain authorization without enabling sync',async()=>{
 const view=render(<><InlineNotifications/><SettingsPage/></>);fireEvent.change(view.getByPlaceholderText('Supabase owner email'),{target:{value:'synthetic@example.invalid'}});fireEvent.change(view.getByPlaceholderText('Supabase owner password'),{target:{value:'wrong'}});fireEvent.click(view.getByRole('button',{name:'Connect Supabase Owner'}));await view.findByText('Synthetic owner credentials rejected');
 fireEvent.change(view.getByPlaceholderText('Supabase owner password'),{target:{value:'owner-test-password'}});fireEvent.click(view.getByRole('button',{name:'Connect Supabase Owner'}));await view.findByRole('button',{name:'Save Business and Branch'});await reloadLocalState();
 fireEvent.click(view.getByRole('button',{name:'Save Business and Branch'}));await waitFor(()=>expect(getLocalState().association).toMatchObject({businessId:'qa-business',branchId:'qa-branch',ownerUserId:'qa-owner'}));expect(getUsers()).toHaveLength(1);
 await view.findByText('Business and branch saved locally. Cloud synchronization remains disabled.');fireEvent.click(view.getByRole('button',{name:'Sign Out of Supabase'}));await view.findByRole('button',{name:'Connect Supabase Owner'});expect(getLocalState().association?.branchId).toBe('qa-branch');
});
it('the branch-save control cannot bypass local administrator authorization for a cashier',async()=>{
 owner.connected=true;await addUser({username:'cashier',password:'cashier-test-password',name:'Cashier',role:'cashier'});await login('cashier','cashier-test-password');
 const view=render(<><InlineNotifications/><SettingsPage/></>);await view.findByText('Synthetic Market',{selector:'option'});fireEvent.click(view.getByRole('button',{name:'Save Business and Branch'}));await view.findByText('Business and branch were not saved: Administrator authorization is required.');expect(getLocalState().association).toBeNull();expect(getUsers()).toHaveLength(2);
});
it('settings reject invalid rates and duplicate users while preserving existing accounts',async()=>{
 const view=render(<><InlineNotifications/><SettingsPage/></>);const rate=view.getByRole('spinbutton');fireEvent.change(rate,{target:{value:'0'}});fireEvent.click(view.getByRole('button',{name:'Save'}));expect(getExchangeRate()).toBe(89500);
 fireEvent.change(rate,{target:{value:'100000'}});fireEvent.click(view.getByRole('button',{name:'Save'}));await waitFor(()=>expect(getExchangeRate()).toBe(100000));
 for(const [label,value]of [['Name','Duplicate'],['Username','admin'],['Password','duplicate-test-password']])fireEvent.change(view.getByPlaceholderText(label),{target:{value}});
 fireEvent.click(view.getByRole('button',{name:'Add User'}));await waitFor(()=>expect(view.getAllByRole('alert').length).toBeGreaterThan(0));expect(getUsers()).toHaveLength(1);
});
