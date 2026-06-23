import { ReactNode } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useNavigate, useLocation } from 'react-router-dom';
import {
  ShoppingCart, Package, FileText, BarChart3, RotateCcw, Settings, LogOut, PackagePlus, TrendingUp, Receipt, Users
} from 'lucide-react';

const navItems = [
  { path: '/pos', label: 'Point of Sale', icon: ShoppingCart, roles: ['admin', 'cashier'] },
  { path: '/inventory', label: 'Inventory', icon: Package, roles: ['admin'] },
  { path: '/inventory-entry', label: 'Add Inventory', icon: PackagePlus, roles: ['admin'] },
  { path: '/receipts', label: 'Receipts', icon: Receipt, roles: ['admin'] },
  { path: '/refunds', label: 'Refunds', icon: RotateCcw, roles: ['admin', 'cashier'] },
  { path: '/daily-movement', label: 'Daily Movement', icon: TrendingUp, roles: ['admin'] },
  { path: '/salesmen', label: 'Salesmen', icon: Users, roles: ['admin'] },
  { path: '/reports', label: 'Reports', icon: FileText, roles: ['admin'] },
  { path: '/analytics', label: 'Analytics', icon: BarChart3, roles: ['admin'] },
  { path: '/settings', label: 'Settings', icon: Settings, roles: ['admin'] },
];

export default function Layout({ children }: { children: ReactNode }) {
  const { user, logout, isAdmin } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const filtered = navItems.filter(n => n.roles.includes(user?.role || ''));

  return (
    <div className="flex h-screen overflow-hidden">
      {/* Sidebar */}
      <aside className="w-60 flex-shrink-0 bg-sidebar flex flex-col">
        <div className="px-5 py-5 border-b border-sidebar-border">
          <h1 className="text-xl font-bold text-sidebar-primary-foreground tracking-tight">SuperMarket</h1>
          <p className="text-xs text-sidebar-muted mt-0.5">Point of Sale System</p>
        </div>

        <nav className="flex-1 py-3 px-3 space-y-0.5 overflow-y-auto">
          {filtered.map(item => {
            const active = location.pathname === item.path;
            return (
              <button
                key={item.path}
                onClick={() => navigate(item.path)}
                className={`pos-sidebar-item w-full ${
                  active
                    ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                    : 'text-sidebar-foreground hover:bg-sidebar-accent/50'
                }`}
              >
                <item.icon size={18} />
                {item.label}
              </button>
            );
          })}
        </nav>

        <div className="p-3 border-t border-sidebar-border space-y-2">
          <div className="px-4 py-2">
            <p className="text-sm font-medium text-sidebar-foreground">{user?.name}</p>
            <p className="text-xs text-sidebar-muted capitalize">{user?.role}</p>
          </div>
          <button
            onClick={() => { logout(); navigate('/login'); }}
            className="pos-sidebar-item w-full text-sidebar-foreground hover:bg-sidebar-accent/50"
          >
            <LogOut size={18} />
            Logout
          </button>
        </div>
      </aside>

      {/* Main */}
      <main className="flex-1 overflow-auto bg-background">
        {children}
      </main>
    </div>
  );
}
