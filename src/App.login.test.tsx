import { render, screen, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.mock('./contexts/AuthContext', () => ({ AuthProvider: ({children}: {children: React.ReactNode}) => <>{children}</>,useAuth: () => ({user:null,isAdmin:false}) }));
vi.mock('./pages/LoginPage', () => ({default: () => <h1>Local POS login</h1>}));
vi.mock('./components/Layout', () => ({default: () => <div>Protected content</div>}));
import App from './App';
import { toast } from './lib/notifications';
beforeEach(() => {window.history.replaceState({}, '', '/');});
afterEach(cleanup);
it.each(['/', '/pos', '/inventory', '/index.html', '/old-version-route'])('opens the local login page on signed-out startup at %s', async path => {
 window.history.replaceState({}, '', path);render(<App />);await screen.findByRole('heading', {name:'Local POS login'});expect(window.location.pathname).toBe('/login');
});
it('does not render global candidate or notification headers',async()=>{
 toast.error('Product not found');render(<App/>);await screen.findByRole('heading',{name:'Local POS login'});
 expect(screen.queryByLabelText('Application messages')).toBeNull();
 expect(screen.queryByLabelText('Unverified test candidate')).toBeNull();
 expect(screen.queryByText('Product not found')).toBeNull();
});
