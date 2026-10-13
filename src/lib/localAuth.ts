import type { User, UserRole } from '@/types/pos';
import { getLocalState, readLocalUsers, localTransaction, stableJson, type LocalState } from './localDatabase';
import { invoke, isTauri } from '@tauri-apps/api/core';

export interface Credential { user: User; salt: string; hash: string; iterations: number; native?: boolean }
async function refreshNativeUsers() {
  const users = await invoke<User[]>('list_local_users');
  await localTransaction(state => { state.users = users.map(user => ({user, salt:'', hash:`native:${user.id}`, iterations:0, native:true})); });
}
let session: { userId: string; hash: string; fingerprint: string } | null = null;
const encode = (bytes: Uint8Array) => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
const decode = (value: string) => Uint8Array.from(value.match(/../g) ?? [], byte => parseInt(byte, 16));
async function derive(password: string, salt: string, iterations: number) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  return encode(new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: decode(salt), iterations, hash: 'SHA-256' }, key, 256)));
}
async function credential(user: User, password: string): Promise<Credential> {
  const salt = encode(crypto.getRandomValues(new Uint8Array(16)));
  const iterations = 600000;
  return { user, salt, iterations, hash: await derive(password, salt, iterations) };
}
export async function initializeLocalAuth() {
  session = null;
  if (isTauri()) { await invoke('logout_local'); await refreshNativeUsers(); return; }
  if (getLocalState().users === undefined) {
    const raw = localStorage.getItem('pos_users');
    const legacy = raw ? JSON.parse(raw) as (User & { password: string })[] : [];
    if (!Array.isArray(legacy)) throw new Error('Invalid legacy users.');
    const migrated: Credential[] = [];
    for (const old of legacy) {
      // Public defaults are not valid credentials; fresh setup is required.
      if (['admin123', 'cashier123'].includes(old.password)) continue;
      const { password, ...user } = old;
      if (!password || !['admin', 'cashier'].includes(user.role)) throw new Error('Invalid legacy credential.');
      migrated.push(await credential(user, password));
    }
    await localTransaction(state => { state.users ??= migrated; });
  }
  // Retain original upgrade evidence. Never trust persisted session objects.
  // Supabase owns its separate persisted session. Local account initialization
  // never clears the branch association or the connected owner session.
}
export function getCurrentUser(): User | null {
  if (!session) return null;
  const saved = readLocalUsers().find(item => item.user.id === session!.userId && item.hash === session!.hash && stableJson(item) === session!.fingerprint);
  return saved?.user ?? null;
}
export function requireOperator(state: LocalState, admin = false): User {
  const saved = state.users?.find(item => item.user.id === session?.userId && item.hash === session?.hash && stableJson(item) === session?.fingerprint);
  if (!saved || (admin && saved.user.role !== 'admin')) throw new Error(admin ? 'Administrator authorization is required.' : 'Sign in before making changes.');
  return saved.user;
}
export function getUsers(): User[] { return getLocalState().users?.map(item => item.user) ?? []; }
export function needsAdministratorSetup() { return isTauri() ? getUsers().length === 0 : !getUsers().some(user => user.role === 'admin'); }
export async function addUser(input: { username: string; name: string; role: UserRole; password: string }, bootstrap = false): Promise<User> {
  if (isTauri()) {
    if (bootstrap) {
      if (input.role !== 'admin') throw new Error('First account must be an administrator.');
      await invoke('create_first_admin', { username:input.username, password:input.password, name:input.name });
    } else await invoke('add_local_user', input);
    await refreshNativeUsers();
    return getUsers().find(user => user.username === input.username.trim())!;
  }
  if (!input.username.trim() || !input.name.trim() || input.password.length < 12 || ['admin123', 'cashier123'].includes(input.password)) throw new Error('Provide a name, unique username, and password of at least 12 characters.');
  const user = { id: crypto.randomUUID(), username: input.username.trim(), name: input.name.trim(), role: input.role };
  const record = await credential(user, input.password);
  return localTransaction(state => {
    state.users ??= [];
    if (bootstrap) {
      if (state.users.some(item => item.user.role === 'admin') || input.role !== 'admin') throw new Error('Administrator setup is already complete.');
    } else requireOperator(state, true);
    if (state.users.some(item => item.user.username.toLowerCase() === user.username.toLowerCase())) throw new Error('Username is already in use.');
    state.users.push(record);
    return user;
  });
}
export async function login(username: string, password: string): Promise<User | null> {
  session = null;
  if (isTauri()) {
    const user = await invoke<User | null>('login_local', { username, password });
    if (!user) return null;
    await refreshNativeUsers();
    const record = getLocalState().users!.find(record => record.user.id === user.id)!;
    session = { userId:user.id, hash:record.hash, fingerprint:stableJson(record) };
    return user;
  }
  const record = getLocalState().users?.find(item => item.user.username.toLowerCase() === username.trim().toLowerCase());
  if (!record) return null;
  const hash = await derive(password, record.salt, record.iterations);
  let difference = hash.length ^ record.hash.length;
  for (let i = 0; i < hash.length; i++) difference |= hash.charCodeAt(i) ^ record.hash.charCodeAt(i);
  if (difference) return null;
  session = { userId: record.user.id, hash: record.hash, fingerprint: stableJson(record) };
  return getCurrentUser();
}
export async function logout(): Promise<void> {
  session = null;
  if (isTauri()) await invoke('logout_local');
  // Operator changes must not disconnect the device's authorized cloud owner.
  // Explicit cloud disconnection remains an administrator-only Settings action.
}
export async function deleteUser(id: string) {
  if (isTauri()) { await invoke('remove_local_user', {id}); await refreshNativeUsers(); return; }
  await localTransaction(state => {
    requireOperator(state, true);
    const record = state.users?.find(item => item.user.id === id);
    if (record?.user.role === 'admin' && state.users!.filter(item => item.user.role === 'admin').length === 1) throw new Error('The last administrator cannot be deleted.');
    state.users = state.users?.filter(item => item.user.id !== id);
  });
  if (session?.userId === id) session = null;
}
