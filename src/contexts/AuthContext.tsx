import { subscribeLocalState } from '@/lib/localDatabase';
import PasswordRotation from '@/components/PasswordRotation';
import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { User } from '@/types/pos';
import { login as storeLogin, getCurrentUser, logout as storeLogout, initializeStore } from '@/lib/store';

interface AuthContextType {
  user: User | null;
  login: (username: string, password: string) => Promise<boolean>;
  logout: () => Promise<void>;
  isAdmin: boolean;
}

const AuthContext = createContext<AuthContextType | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [failure, setFailure] = useState('');
  const [user, setUser] = useState<User | null>(null);

  useEffect(() => {
    let mounted = true;
    void initializeStore().then(() => { if (mounted) { setUser(getCurrentUser()); setReady(true); } }).catch(error => { if (mounted) setFailure(error instanceof Error ? error.message : String(error)); });
    return () => { mounted = false; };
  }, []);

  useEffect(() => subscribeLocalState(() => { setUser(getCurrentUser()); }), []);

  const login = async (username: string, password: string): Promise<boolean> => {
    setUser(null);
    const found = await storeLogin(username, password);
    setUser(found);
    return Boolean(found);
  };

  const logout = async () => {
    setUser(null);
    await storeLogout();
  };

  if (failure) return <div role="alert" className="p-6">POS could not open its local database: {failure}. Original data has been preserved.</div>;
  if (!ready) return <div role="status" className="p-6">Opening local POS database…</div>;
  if (user?.requiresPasswordChange) return <PasswordRotation onComplete={logout} />;
  return (
    <AuthContext.Provider value={{ user, login, logout, isAdmin: user?.role === 'admin' }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
