import { businessDate, movements, csv } from '@/lib/accounting';
import { useState, useMemo } from 'react';
import { formatCurrency } from '@/lib/store';
import LocalReportScope from '@/components/LocalReportScope';
import type {Sale,Refund} from '@/types/pos';
import { useAuth } from '@/contexts/AuthContext';
import { FileText, Download, Search, Users, BarChart3, ArrowUpDown } from 'lucide-react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from 'recharts';

export default function ReportsPage() {
  return <LocalReportScope>{(sales,refunds)=><VerifiedReports sales={sales} refunds={refunds}/>}</LocalReportScope>;
}
function VerifiedReports({sales,refunds}:{sales:Sale[];refunds:Refund[]}) {
  const { isAdmin } = useAuth();
  const [period, setPeriod] = useState<'daily' | 'monthly' | 'range'>('daily');
  const [selectedDate, setSelectedDate] = useState(businessDate());
  const [selectedMonth, setSelectedMonth] = useState(businessDate().slice(0, 7));
  const [dateFrom, setDateFrom] = useState(businessDate());
  const [dateTo, setDateTo] = useState(businessDate());
  const [searchQuery, setSearchQuery] = useState('');
  const [sortBy, setSortBy] = useState<'revenue' | 'sales' | 'name'>('revenue');

  const report = useMemo(() => {
    return movements(sales, refunds, date => period === 'daily' ? date === selectedDate : period === 'monthly' ? date.startsWith(selectedMonth) : date >= dateFrom && date <= dateTo, searchQuery.trim());
  }, [period, selectedDate, selectedMonth, dateFrom, dateTo, searchQuery, sales, refunds]);

  // User sales tracking (admin only)
  const userSalesData = useMemo(() => {
    if (!isAdmin) return { byUser: [], dailyTotal: 0, monthlyTotal: 0, chartData: [] };

    const allNonRefunded = sales.filter(sale => !sale.legacy);
    const today = businessDate();
    const currentMonth = businessDate().slice(0, 7);

    // Group by cashier
    const userMap = new Map<string, { name: string; dailyRev: number; dailySales: number; monthlyRev: number; monthlySales: number; totalRev: number; totalSales: number }>();

    allNonRefunded.forEach(s => {
      const rev = s.items.reduce((a, i) => a + i.salePrice * i.quantity, 0);
      const saleDate = businessDate(s.date);
      const saleMonth = businessDate(s.date).slice(0, 7);

      if (!userMap.has(s.cashierName)) {
        userMap.set(s.cashierName, { name: s.cashierName, dailyRev: 0, dailySales: 0, monthlyRev: 0, monthlySales: 0, totalRev: 0, totalSales: 0 });
      }
      const u = userMap.get(s.cashierName)!;
      u.totalRev += rev;
      u.totalSales += 1;
      if (saleDate === today) { u.dailyRev += rev; u.dailySales += 1; }
      if (saleMonth === currentMonth) { u.monthlyRev += rev; u.monthlySales += 1; }
    });

    const byUser = Array.from(userMap.values());
    if (sortBy === 'revenue') byUser.sort((a, b) => b.totalRev - a.totalRev);
    else if (sortBy === 'sales') byUser.sort((a, b) => b.totalSales - a.totalSales);
    else byUser.sort((a, b) => a.name.localeCompare(b.name));

    const dailyTotal = byUser.reduce((s, u) => s + u.dailyRev, 0);
    const monthlyTotal = byUser.reduce((s, u) => s + u.monthlyRev, 0);

    const chartData = byUser.map(u => ({
      name: u.name,
      'Today': u.dailyRev,
      'This Month': u.monthlyRev,
    }));

    return { byUser, dailyTotal, monthlyTotal, chartData };
  }, [sales, isAdmin, sortBy]);

  const exportCSV = () => {
    const headers = ['Type', 'ID', 'Date', 'Items', 'Revenue USD', 'Cost USD', 'Profit USD', 'Settlement Currency', 'Settlement Amount', 'Cashier'];
    const rows = [...report.filteredSales.map(record => ({ record, type: 'Sale', sign: 1, settlement: record.total })), ...report.filteredRefunds.map(record => ({ record, type: 'Refund', sign: -1, settlement: record.totalRefunded }))].map(({ record, type, sign, settlement }) => {
      const revenue = sign * record.items.reduce((sum, item) => sum + item.salePrice * item.quantity, 0);
      const cost = sign * record.items.reduce((sum, item) => sum + item.purchasePrice * item.quantity, 0);
      return [type, record.id, record.date, record.items.map(item => `${item.productName} x${item.quantity}`).join('; '), revenue, cost, revenue - cost, record.currency, sign * settlement, record.cashierName];
    });
    const blob = new Blob([csv([headers, ...rows])], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a'); link.href = url; link.download = `report_${selectedDate}.csv`; link.click(); URL.revokeObjectURL(url);
  };

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <FileText className="text-primary" size={24} />
          <h2 className="pos-header">Reports</h2>
        </div>
        <button onClick={exportCSV} className="pos-btn-secondary flex items-center gap-2">
          <Download size={16} /> Export CSV
        </button>
      </div>

      {/* Filters */}
      <div className="pos-card p-4 mb-6 space-y-4">
        <div className="flex items-center gap-3 flex-wrap">
          {/* Period selector */}
          <div className="flex rounded-lg border border-border overflow-hidden">
            {(['daily', 'monthly', 'range'] as const).map(p => (
              <button
                key={p}
                onClick={() => setPeriod(p)}
                className={`px-4 py-2 text-sm font-medium capitalize transition-colors ${
                  period === p ? 'bg-primary text-primary-foreground' : 'bg-card text-muted-foreground hover:bg-muted'
                }`}
              >
                {p === 'range' ? 'Date Range' : p}
              </button>
            ))}
          </div>

          {/* Date inputs */}
          {period === 'daily' && (
            <input type="date" className="pos-input" value={selectedDate} onChange={e => setSelectedDate(e.target.value)} />
          )}
          {period === 'monthly' && (
            <input type="month" className="pos-input" value={selectedMonth} onChange={e => setSelectedMonth(e.target.value)} />
          )}
          {period === 'range' && (
            <div className="flex items-center gap-2">
              <input type="date" className="pos-input" value={dateFrom} onChange={e => setDateFrom(e.target.value)} />
              <span className="text-muted-foreground text-sm">to</span>
              <input type="date" className="pos-input" value={dateTo} onChange={e => setDateTo(e.target.value)} />
            </div>
          )}
        </div>

        {/* Product search */}
        <div className="relative w-80">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" size={16} />
          <input
            className="pos-input w-full pl-9"
            placeholder="Search by product name or barcode..."
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
          />
        </div>
      </div>

      {/* Summary */}
      <div className="grid grid-cols-4 gap-4 mb-6">
        {[
          { label: 'Revenue', value: formatCurrency(report.totalRevenue, 'USD'), sub: `${report.numSales} sales` },
          { label: 'Costs', value: formatCurrency(report.totalCost, 'USD'), sub: `Purchase costs` },
          { label: 'Net Profit', value: formatCurrency(report.totalProfit, 'USD'), sub: `${report.marginPercent.toFixed(1)}% margin` },
          { label: 'Refunded', value: formatCurrency(report.totalRefunded, 'USD'), sub: `${report.numRefunds} refunds` },
        ].map(c => (
          <div key={c.label} className="pos-card p-5">
            <p className="text-sm text-muted-foreground">{c.label}</p>
            <p className="text-2xl font-bold mt-1">{c.value}</p>
            <p className="text-xs text-muted-foreground mt-1">{c.sub}</p>
          </div>
        ))}
      </div>

      {/* Sales Detail */}
      <div className="pos-card overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="pos-table-header">
              <th className="text-left py-3 px-4">Sale #</th>
              <th className="text-left py-3 px-4">Date</th>
              <th className="text-left py-3 px-4">Items</th>
              <th className="text-right py-3 px-4">Revenue</th>
              <th className="text-right py-3 px-4">Cost</th>
              <th className="text-right py-3 px-4">Profit</th>
              <th className="text-right py-3 px-4">Margin</th>
              <th className="text-left py-3 px-4">Cashier</th>
            </tr>
          </thead>
          <tbody>
            {report.filteredSales.length === 0 ? (
              <tr><td colSpan={8} className="text-center py-12 text-muted-foreground">No sales for this period</td></tr>
            ) : report.filteredSales.map(s => {
              const rev = s.items.reduce((a, i) => a + i.salePrice * i.quantity, 0);
              const cost = s.items.reduce((a, i) => a + i.purchasePrice * i.quantity, 0);
              const profit = rev - cost;
              const margin = rev > 0 ? ((profit / rev) * 100).toFixed(1) : '0.0';
              return (
                <tr key={s.id} className="border-b border-border">
                  <td className="py-3 px-4 font-mono text-xs">#{s.id.slice(-6)}</td>
                  <td className="py-3 px-4 text-muted-foreground">{new Date(s.date).toLocaleString()}</td>
                  <td className="py-3 px-4">{s.items.map(i => `${i.productName} (x${i.quantity})`).join(', ')}</td>
                  <td className="py-3 px-4 text-right">${rev.toFixed(2)}</td>
                  <td className="py-3 px-4 text-right text-muted-foreground">${cost.toFixed(2)}</td>
                  <td className="py-3 px-4 text-right text-success font-medium">${profit.toFixed(2)}</td>
                  <td className="py-3 px-4 text-right font-medium">{margin}%</td>
                  <td className="py-3 px-4 text-muted-foreground">{s.cashierName}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Admin Only: User Sales Tracking */}
      {isAdmin && (
        <>
          {/* Section: Total Sales Summary */}
          <div className="mt-8 mb-6">
            <div className="flex items-center gap-3 mb-4">
              <BarChart3 className="text-primary" size={22} />
              <h3 className="text-lg font-bold">Gross Sales Summary</h3>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="pos-card p-5">
                <p className="text-sm text-muted-foreground">Today's Total Sales</p>
                <p className="text-2xl font-bold mt-1">{formatCurrency(userSalesData.dailyTotal, 'USD')}</p>
                <p className="text-xs text-muted-foreground mt-1">All users combined</p>
              </div>
              <div className="pos-card p-5">
                <p className="text-sm text-muted-foreground">This Month's Total Sales</p>
                <p className="text-2xl font-bold mt-1">{formatCurrency(userSalesData.monthlyTotal, 'USD')}</p>
                <p className="text-xs text-muted-foreground mt-1">All users combined</p>
              </div>
            </div>
          </div>

          {/* Chart: Daily vs Monthly by User */}
          {userSalesData.chartData.length > 0 && (
            <div className="pos-card p-5 mb-6">
              <h4 className="text-sm font-semibold mb-4 text-muted-foreground">Sales by User — Today vs This Month</h4>
              <ResponsiveContainer width="100%" height={280}>
                <BarChart data={userSalesData.chartData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                  <XAxis dataKey="name" tick={{ fontSize: 12 }} />
                  <YAxis tick={{ fontSize: 12 }} />
                  <Tooltip formatter={(value: number) => `$${value.toFixed(2)}`} />
                  <Legend />
                  <Bar dataKey="Today" fill="hsl(var(--primary))" radius={[4, 4, 0, 0]} />
                  <Bar dataKey="This Month" fill="hsl(var(--accent))" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}

          {/* Section: Sales by User Table */}
          <div className="mb-6">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-3">
                <Users className="text-primary" size={22} />
                <h3 className="text-lg font-bold">Sales by User</h3>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">Sort by:</span>
                <div className="flex rounded-lg border border-border overflow-hidden">
                  {(['revenue', 'sales', 'name'] as const).map(s => (
                    <button
                      key={s}
                      onClick={() => setSortBy(s)}
                      className={`px-3 py-1.5 text-xs font-medium capitalize transition-colors ${
                        sortBy === s ? 'bg-primary text-primary-foreground' : 'bg-card text-muted-foreground hover:bg-muted'
                      }`}
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            </div>
            <div className="pos-card overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="pos-table-header">
                    <th className="text-left py-3 px-4">User</th>
                    <th className="text-right py-3 px-4">Today's Sales</th>
                    <th className="text-right py-3 px-4">Today's Gross Revenue</th>
                    <th className="text-right py-3 px-4">Monthly Sales</th>
                    <th className="text-right py-3 px-4">Monthly Gross Revenue</th>
                    <th className="text-right py-3 px-4">Total Sales</th>
                    <th className="text-right py-3 px-4">Gross Revenue</th>
                  </tr>
                </thead>
                <tbody>
                  {userSalesData.byUser.length === 0 ? (
                    <tr><td colSpan={7} className="text-center py-12 text-muted-foreground">No sales data available</td></tr>
                  ) : userSalesData.byUser.map(u => (
                    <tr key={u.name} className="border-b border-border">
                      <td className="py-3 px-4 font-medium">{u.name}</td>
                      <td className="py-3 px-4 text-right">{u.dailySales}</td>
                      <td className="py-3 px-4 text-right">{formatCurrency(u.dailyRev, 'USD')}</td>
                      <td className="py-3 px-4 text-right">{u.monthlySales}</td>
                      <td className="py-3 px-4 text-right">{formatCurrency(u.monthlyRev, 'USD')}</td>
                      <td className="py-3 px-4 text-right font-medium">{u.totalSales}</td>
                      <td className="py-3 px-4 text-right font-bold">{formatCurrency(u.totalRev, 'USD')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
