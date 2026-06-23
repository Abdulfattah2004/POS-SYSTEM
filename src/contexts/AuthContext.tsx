import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { User } from '@/types/pos';
import { loginSql } from '@/lib/sqlStore';

interface AuthContextType {
  user: User | null;
  login: (username: string, password: string) => Promise<boolean>;
  logout: () => void;
  isAdmin: boolean;
}

const AuthContext = createContext<AuthContextType | null>(null);

function getCurrentUser(): User | null {
  try {
    const raw = localStorage.getItem('pos_current_user');
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function setCurrentUser(user: User | null) {
  localStorage.setItem('pos_current_user', JSON.stringify(user));
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);

  useEffect(() => {
    const saved = getCurrentUser();
    if (saved) setUser(saved);
  }, []);

  const login = async (username: string, password: string): Promise<boolean> => {
    const found = await loginSql(username, password);

    if (found) {
      setUser(found);
      setCurrentUser(found);
      return true;
    }

    return false;
  };

  const logout = () => {
    setUser(null);
    setCurrentUser(null);
  };

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