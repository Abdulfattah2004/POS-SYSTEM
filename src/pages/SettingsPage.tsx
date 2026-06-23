import { useEffect, useState } from 'react';
import { Settings, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { User, UserRole } from '@/types/pos';
import {
  getExchangeRateSql,
  setExchangeRateSql,
  getUsersSql,
  addUserSql,
  deleteUserSql,
} from '@/lib/sqlStore';

export default function SettingsPage() {
  const [rate, setRate] = useState('89500');
  const [users, setUsers] = useState<User[]>([]);
  const [newUser, setNewUser] = useState({
    username: '',
    password: '',
    name: '',
    role: 'cashier' as UserRole,
  });

  const loadData = async () => {
    setRate(String(await getExchangeRateSql()));
    setUsers(await getUsersSql());
  };

  useEffect(() => {
    loadData().catch(error => {
      console.error('Failed to load settings:', error);
      alert('Failed to load settings: ' + error);
    });
  }, []);

  const saveRate = async () => {
    const num = Number(rate);
    if (num > 0) {
      await setExchangeRateSql(num);
      toast.success('Exchange rate updated');
    }
  };

  const handleAddUser = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!newUser.username || !newUser.password || !newUser.name) {
      toast.error('Fill all fields');
      return;
    }

    await addUserSql(newUser);
    await loadData();

    setNewUser({ username: '', password: '', name: '', role: 'cashier' });
    toast.success('User added');
  };

  const handleDeleteUser = async (user: User) => {
    if (!confirm(`Delete user "${user.name}"?`)) return;

    await deleteUserSql(user.id);
    await loadData();
    toast.success('User deleted');
  };

  return (
    <div className="p-6 max-w-2xl space-y-8">
      <div className="flex items-center gap-3">
        <Settings className="text-primary" size={24} />
        <h2 className="pos-header">Settings</h2>
      </div>

      <div className="pos-card p-6">
        <h3 className="font-semibold text-foreground mb-4">
          Exchange Rate (USD → LBP)
        </h3>

        <div className="flex gap-3">
          <div className="flex items-center gap-2 flex-1">
            <span className="text-sm text-muted-foreground">1 USD =</span>
            <input
              type="number"
              className="pos-input flex-1"
              value={rate}
              onChange={e => setRate(e.target.value)}
            />
            <span className="text-sm text-muted-foreground">L.L</span>
          </div>

          <button onClick={saveRate} className="pos-btn-primary">
            Save
          </button>
        </div>
      </div>

      <div className="pos-card p-6">
        <h3 className="font-semibold text-foreground mb-4">User Management</h3>

        <div className="mb-4">
          <table className="w-full text-sm">
            <thead>
              <tr className="pos-table-header">
                <th className="text-left py-2 px-3">Name</th>
                <th className="text-left py-2 px-3">Username</th>
                <th className="text-left py-2 px-3">Role</th>
                <th className="text-right py-2 px-3">Action</th>
              </tr>
            </thead>

            <tbody>
              {users.map(u => (
                <tr key={u.id} className="border-b border-border">
                  <td className="py-2 px-3">{u.name}</td>
                  <td className="py-2 px-3 font-mono text-xs">{u.username}</td>
                  <td className="py-2 px-3 capitalize">{u.role}</td>
                  <td className="py-2 px-3 text-right">
                    <button
                      onClick={() => handleDeleteUser(u)}
                      className="text-destructive hover:text-destructive/80 transition-colors"
                    >
                      <Trash2 size={16} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <form onSubmit={handleAddUser} className="grid grid-cols-2 gap-3">
          <input
            className="pos-input"
            placeholder="Name"
            value={newUser.name}
            onChange={e => setNewUser({ ...newUser, name: e.target.value })}
          />

          <input
            className="pos-input"
            placeholder="Username"
            value={newUser.username}
            onChange={e => setNewUser({ ...newUser, username: e.target.value })}
          />

          <input
            className="pos-input"
            placeholder="Password"
            type="password"
            value={newUser.password}
            onChange={e => setNewUser({ ...newUser, password: e.target.value })}
          />

          <select
            className="pos-input"
            value={newUser.role}
            onChange={e =>
              setNewUser({ ...newUser, role: e.target.value as UserRole })
            }
          >
            <option value="cashier">Cashier</option>
            <option value="admin">Admin</option>
          </select>

          <button type="submit" className="pos-btn-primary col-span-2">
            Add User
          </button>
        </form>
      </div>
    </div>
  );
}