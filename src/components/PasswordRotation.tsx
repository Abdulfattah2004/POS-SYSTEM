import { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
export default function PasswordRotation({onComplete}:{onComplete:()=>Promise<void>}) {
  const [password,setPassword]=useState(''); const [confirmation,setConfirmation]=useState('');
  const [error,setError]=useState(''); const [busy,setBusy]=useState(false);
  return <div className="min-h-screen flex items-center justify-center p-6"><form className="pos-card p-6 space-y-4 max-w-md" onSubmit={async e=>{
    e.preventDefault(); if(busy)return; if(password.length<12 || password!==confirmation){setError('Enter matching passwords of at least 12 characters.');return;}
    setBusy(true); try {await invoke('change_local_password',{password});await onComplete();} catch(error){setError(String(error));} finally{setBusy(false);}
  }}><h1 className="text-xl font-bold">Secure your existing account</h1><p>Your account and records are preserved. Choose a new password before continuing.</p>
    {error&&<p role="alert" className="text-destructive">{error}</p>}
    <label className="block">New password<input type="password" autoComplete="new-password" minLength={12} required className="pos-input w-full" value={password} onChange={e=>setPassword(e.target.value)}/></label>
    <label className="block">Confirm password<input type="password" autoComplete="new-password" required className="pos-input w-full" value={confirmation} onChange={e=>setConfirmation(e.target.value)}/></label>
    <button disabled={busy} className="pos-btn-primary" type="submit">Save password and sign in again</button>
  </form></div>;
}
