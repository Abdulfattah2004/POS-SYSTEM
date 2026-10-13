import { addUser, needsAdministratorSetup } from '@/lib/store';
import { useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useNavigate } from 'react-router-dom';
import { ShoppingCart, Eye, EyeOff } from 'lucide-react';

export default function LoginPage() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const setup = needsAdministratorSetup();
  const { login } = useAuth();
  const navigate = useNavigate();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
    if (setup) await addUser({ username, password, name: username, role: 'admin' }, true);
    if (await login(username, password)) {
      navigate('/pos');
    } else {
      setError('Invalid username or password');
    }
    } catch (error) { setError(error instanceof Error ? error.message : 'Sign-in failed'); }
    finally { setBusy(false); }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-primary mb-4">
            <ShoppingCart className="text-primary-foreground" size={28} />
          </div>
          <h1 className="text-2xl font-bold text-foreground">SuperMarket POS</h1>
          <p className="text-sm text-muted-foreground mt-1">{setup ? 'Create the first administrator (12+ character password)' : 'Sign in to continue'}</p>
        </div>

        <form onSubmit={handleSubmit} className="pos-card p-6 space-y-4">
          {error && (
            <div role="alert" className="bg-destructive/10 text-destructive text-sm px-4 py-2.5 rounded-md">
              {error}
            </div>
          )}

          <div>
            <label htmlFor="local-username" className="block text-sm font-medium text-foreground mb-1.5">Username</label>
            <input
              id="local-username" autoComplete="username" required
              className="pos-input w-full"
              value={username}
              onChange={e => setUsername(e.target.value)}
              placeholder="Enter username"
              autoFocus
            />
          </div>

          <div>
            <label htmlFor="local-password" className="block text-sm font-medium text-foreground mb-1.5">Password</label>
            <div className="relative">
              <input
                id="local-password" autoComplete={setup ? 'new-password' : 'current-password'} required
                type={showPw ? 'text' : 'password'}
                className="pos-input w-full pr-10"
                value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder="Enter password"
              />
              <button
                type="button"
                aria-label={showPw ? 'Hide password' : 'Show password'}
                onClick={() => setShowPw(!showPw)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                {showPw ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
          </div>

          <button type="submit" disabled={busy} className="pos-btn-primary w-full">
            Sign In
          </button>


        </form>
      </div>
    </div>
  );
}
