import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AuthProvider, useAuth } from './AuthContext';
const mocks = vi.hoisted(() => ({ initialize: vi.fn(), login: vi.fn(), logout: vi.fn(), current: vi.fn() }));
vi.mock('@/lib/store', () => ({ initializeStore: mocks.initialize, login: mocks.login, logout: mocks.logout, getCurrentUser: mocks.current }));
vi.mock('@/lib/localDatabase', () => ({ subscribeLocalState: () => () => {} }));
vi.mock('@/components/PasswordRotation', () => ({ default: () => <div>Password rotation</div> }));
const user = { id: 'local-admin', username: 'admin', role: 'admin' as const, name: 'Synthetic' };
function View() {const auth=useAuth();return <><span>{auth.user?.username ?? 'Signed out'}</span><button onClick={() => void auth.login('admin', 'synthetic-password')}>Local login</button></>;}
beforeEach(() => {vi.clearAllMocks();mocks.initialize.mockResolvedValue(undefined);mocks.current.mockReturnValue(null);mocks.login.mockResolvedValue(user);});
afterEach(cleanup);
it('waits for local initialization and opens the signed-out UI without a cloud session', async () => {
 let ready!: () => void;mocks.initialize.mockImplementationOnce(() => new Promise<void>(resolve => {ready=resolve;}));
 render(<AuthProvider><View /></AuthProvider>);expect(screen.getByRole('status')).toHaveTextContent('Opening local POS database');ready();
 await screen.findByText('Signed out');expect(mocks.login).not.toHaveBeenCalled();
});
it('clears a previous UI session if a subsequent local login fails', async () => {
 render(<AuthProvider><View /></AuthProvider>);await screen.findByText('Signed out');fireEvent.click(screen.getByRole('button'));await screen.findByText('admin');
 mocks.login.mockResolvedValueOnce(null);fireEvent.click(screen.getByRole('button'));await screen.findByText('Signed out');
});
it('a fresh provider mount requires local login again rather than restoring a persisted session', async () => {
 const first=render(<AuthProvider><View /></AuthProvider>);await screen.findByText('Signed out');fireEvent.click(screen.getByRole('button'));await screen.findByText('admin');first.unmount();
 render(<AuthProvider><View /></AuthProvider>);await screen.findByText('Signed out');expect(mocks.initialize).toHaveBeenCalledTimes(2);
});
it('shows a visible initialization failure and never opens protected UI', async () => {
 mocks.initialize.mockRejectedValueOnce(new Error('Local database unavailable'));render(<AuthProvider><View /></AuthProvider>);
 await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Local database unavailable'));expect(screen.queryByRole('button')).not.toBeInTheDocument();
});
