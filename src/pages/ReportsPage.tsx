import { useState, useMemo, useEffect } from 'react';
import { formatCurrency } from '@/lib/store';
import { getSalesSql, getRefundsSql } from '@/lib/sqlStore';
import { useAuth } from '@/contexts/AuthContext';
import { FileText, Download, Search, Users, BarChart3 } from 'lucide-react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from 'recharts';

export default function ReportsPage() {
  const { isAdmin } = useAuth();
  const [period, setPeriod] = useState<'daily' | 'monthly' | 'range'>('daily');
  const [selectedDate, setSelectedDate] = useState(new Date().toISOString().split('T')[0]);
  const [selectedMonth, setSelectedMonth] = useState(new Date().toISOString().slice(0, 7));
  const [dateFrom, setDateFrom] = useState(new Date().toISOString().split('T')[0]);
  const [dateTo, setDateTo] = useState(new Date().toISOString().split('T')[0]);
  const [searchQuery, setSearchQuery] = useState('');
  const [sortBy, setSortBy] = useState<'revenue' | 'sales' | 'name'>('revenue');
  const [sales, setSales] = useState<any[]>([]);
  const [refunds, setRefunds] = useState<any[]>([]);

  useEffect(() => {
    async function loadData() {
      setSales(await getSalesSql());
      setRefunds(await getRefundsSql());
    }

    loadData().catch(error => {
      console.error('Failed to load reports:', error);
      alert('Failed to load reports: ' + error);
    });
  }, []);

  const toLocalDay = (iso: string) => {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  };

  const toLocalMonth = (iso: string) => toLocalDay(iso).slice(0, 7);

  const report = useMemo(() => {
    let filteredSales = sales.filter(s => !s.refunded);

    if (period === 'daily') {
      filteredSales = filteredSales.filter(s => toLocalDay(s.date) === selectedDate);
    } else if (period === 'monthly') {
      filteredSales = filteredSales.filter(s => toLocalMonth(s.date) === selectedMonth);
    } else {
      filteredSales = filteredSales.filter(s => {
        const d = toLocalDay(s.date);
        return d >= dateFrom && d <= dateTo;
      });
    }

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      filteredSales = filteredSales.filter(s =>
        s.items.some(i =>
          i.productName.toLowerCase().includes(q) ||
          i.barcode.includes(q)
        )
      );
    }

    const dateFilterForRefunds =
      period === 'daily' ? selectedDate : period === 'monthly' ? selectedMonth : null;

    let filteredRefunds = refunds;

    if (period === 'range') {
      filteredRefunds = refunds.filter(r => {
        const d = toLocalDay(r.date);
        return d >= dateFrom && d <= dateTo;
      });
    } else if (dateFilterForRefunds) {
      filteredRefunds =
        period === 'daily'
          ? refunds.filter(r => toLocalDay(r.date) === dateFilterForRefunds)
          : refunds.filter(r => toLocalMonth(r.date) === dateFilterForRefunds);
    }

    const totalRevenue = filteredSales.reduce(
      (s, sale) =>
        s + sale.items.reduce((a, i) => a + i.salePrice * i.quantity, 0),
      0
    );

    const totalCost = filteredSales.reduce(
      (s, sale) =>
        s + sale.items.reduce((a, i) => a + i.purchasePrice * i.quantity, 0),
      0
    );

    const totalRefunded = filteredRefunds.reduce(
      (s, r) =>
        s + r.items.reduce((a, i) => a + i.salePrice * i.quantity, 0),
      0
    );

    const totalProfit = totalRevenue - totalCost;
    const marginPercent = totalCost > 0 ? (totalProfit / totalCost) * 100 : 0;
    const numSales = filteredSales.length;
    const numRefunds = filteredRefunds.length;

    return {
      totalRevenue,
      totalCost,
      totalProfit,
      totalRefunded,
      numSales,
      numRefunds,
      filteredSales,
      marginPercent,
    };
  }, [period, selectedDate, selectedMonth, dateFrom, dateTo, searchQuery, sales, refunds]);

  const userSalesData = useMemo(() => {
    if (!isAdmin) {
      return {
        byUser: [],
        dailyTotal: 0,
        monthlyTotal: 0,
        chartData: [],
        dailyLabel: '',
        monthlyLabel: '',
      };
    }

    const allNonRefunded = sales.filter(s => !s.refunded);
    const todayLocal = toLocalDay(new Date().toISOString());
    const currentMonthLocal = todayLocal.slice(0, 7);

    const targetDay =
      period === 'daily' ? selectedDate : period === 'monthly' ? '' : todayLocal;

    const targetMonth =
      period === 'monthly'
        ? selectedMonth
        : period === 'daily'
          ? selectedDate.slice(0, 7)
          : currentMonthLocal;

    const userMap = new Map<
      string,
      {
        name: string;
        dailyRev: number;
        dailySales: number;
        monthlyRev: number;
        monthlySales: number;
        totalRev: number;
        totalSales: number;
      }
    >();

    allNonRefunded.forEach(s => {
      const rev = s.items.reduce((a, i) => a + i.salePrice * i.quantity, 0);
      const saleDate = toLocalDay(s.date);
      const saleMonth = saleDate.slice(0, 7);

      if (period === 'range') {
        if (saleDate < dateFrom || saleDate > dateTo) return;
      }

      if (!userMap.has(s.cashierName)) {
        userMap.set(s.cashierName, {
          name: s.cashierName,
          dailyRev: 0,
          dailySales: 0,
          monthlyRev: 0,
          monthlySales: 0,
          totalRev: 0,
          totalSales: 0,
        });
      }

      const u = userMap.get(s.cashierName)!;
      u.totalRev += rev;
      u.totalSales += 1;

      if (targetDay && saleDate === targetDay) {
        u.dailyRev += rev;
        u.dailySales += 1;
      }

      if (targetMonth && saleMonth === targetMonth) {
        u.monthlyRev += rev;
        u.monthlySales += 1;
      }
    });

    let byUser = Array.from(userMap.values());

    if (sortBy === 'revenue') byUser.sort((a, b) => b.totalRev - a.totalRev);
    else if (sortBy === 'sales') byUser.sort((a, b) => b.totalSales - a.totalSales);
    else byUser.sort((a, b) => a.name.localeCompare(b.name));

    const dailyTotal = byUser.reduce((s, u) => s + u.dailyRev, 0);
    const monthlyTotal = byUser.reduce((s, u) => s + u.monthlyRev, 0);

    const chartData = byUser.map(u => ({
      name: u.name,
      Today: u.dailyRev,
      'This Month': u.monthlyRev,
    }));

    const dailyLabel = targetDay
      ? targetDay === todayLocal
        ? "Today's"
        : targetDay
      : 'Selected Period';

    const monthlyLabel =
      targetMonth === currentMonthLocal ? "This Month's" : targetMonth;

    return { byUser, dailyTotal, monthlyTotal, chartData, dailyLabel, monthlyLabel };
  }, [sales, isAdmin, sortBy, period, selectedDate, selectedMonth, dateFrom, dateTo]);

  const exportCSV = () => {
    const headers = [
      'Sale ID',
      'Date',
      'Items',
      'Revenue',
      'Cost',
      'Profit',
      'Margin %',
      'Currency',
      'Cashier',
    ];

    const rows = report.filteredSales.map(s => {
      const rev = s.items.reduce((a, i) => a + i.salePrice * i.quantity, 0);
      const cost = s.items.reduce((a, i) => a + i.purchasePrice * i.quantity, 0);
      const profit = rev - cost;
      const margin = cost > 0 ? ((profit / cost) * 100).toFixed(1) : '0';

      return [
        s.id,
        new Date(s.date).toLocaleString(),
        s.items.map(i => `${i.productName} x${i.quantity}`).join('; '),
        (Number(rev) || 0).toFixed(2),
        (Number(cost) || 0).toFixed(2),
        (Number(profit) || 0).toFixed(2),
        margin + '%',
        s.currency,
        s.cashierName,
      ];
    });

    const csv = [headers, ...rows].map(r => r.join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');

    a.href = url;
    a.download = `report_${
      period === 'daily'
        ? selectedDate
        : period === 'monthly'
          ? selectedMonth
          : `${dateFrom}_to_${dateTo}`
    }.csv`;

    a.click();
    URL.revokeObjectURL(url);
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

      <div className="pos-card p-4 mb-6 space-y-4">
        <div className="flex items-center gap-3 flex-wrap">
          <div className="flex rounded-lg border border-border overflow-hidden">
            {(['daily', 'monthly', 'range'] as const).map(p => (
              <button
                key={p}
                onClick={() => setPeriod(p)}
                className={`px-4 py-2 text-sm font-medium capitalize transition-colors ${
                  period === p
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-card text-muted-foreground hover:bg-muted'
                }`}
              >
                {p === 'range' ? 'Date Range' : p}
              </button>
            ))}
          </div>

          {period === 'daily' && (
            <input
              type="date"
              className="pos-input"
              value={selectedDate}
              onChange={e => setSelectedDate(e.target.value)}
            />
          )}

          {period === 'monthly' && (
            <input
              type="month"
              className="pos-input"
              value={selectedMonth}
              onChange={e => setSelectedMonth(e.target.value)}
            />
          )}

          {period === 'range' && (
            <div className="flex items-center gap-2">
              <input
                type="date"
                className="pos-input"
                value={dateFrom}
                onChange={e => setDateFrom(e.target.value)}
              />
              <span className="text-muted-foreground text-sm">to</span>
              <input
                type="date"
                className="pos-input"
                value={dateTo}
                onChange={e => setDateTo(e.target.value)}
              />
            </div>
          )}
        </div>

        <div className="relative w-80">
          <Search
            className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground"
            size={16}
          />

          <input
            className="pos-input w-full pl-9"
            placeholder="Search by product name or barcode..."
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
          />
        </div>
      </div>

      <div className="grid grid-cols-4 gap-4 mb-6">
        {[
          {
            label: 'Revenue',
            value: formatCurrency(report.totalRevenue, 'USD'),
            sub: `${report.numSales} sales`,
          },
          {
            label: 'Costs',
            value: formatCurrency(report.totalCost, 'USD'),
            sub: 'Purchase costs',
          },
          {
            label: 'Net Profit',
            value: formatCurrency(report.totalProfit, 'USD'),
            sub: `${(Number(report.marginPercent) || 0).toFixed(1)}% margin`,
          },
          {
            label: 'Refunded',
            value: formatCurrency(report.totalRefunded, 'USD'),
            sub: `${report.numRefunds} refunds`,
          },
        ].map(c => (
          <div key={c.label} className="pos-card p-5">
            <p className="text-sm text-muted-foreground">{c.label}</p>
            <p className="text-2xl font-bold mt-1">{c.value}</p>
            <p className="text-xs text-muted-foreground mt-1">{c.sub}</p>
          </div>
        ))}
      </div>

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
              <tr>
                <td colSpan={8} className="text-center py-12 text-muted-foreground">
                  No sales for this period
                </td>
              </tr>
            ) : searchQuery.trim() ? (
              (() => {
                const q = searchQuery.toLowerCase();
                const itemMap = new Map<
                  string,
                  {
                    productId: string;
                    productName: string;
                    totalQty: number;
                    totalRev: number;
                    totalCost: number;
                  }
                >();

                report.filteredSales.forEach(s => {
                  s.items
                    .filter(i => i.productName.toLowerCase().includes(q) || i.barcode.includes(q))
                    .forEach(i => {
                      const existing =
                        itemMap.get(i.productId) || {
                          productId: i.productId,
                          productName: i.productName,
                          totalQty: 0,
                          totalRev: 0,
                          totalCost: 0,
                        };

                      existing.totalQty += i.quantity;
                      existing.totalRev += (Number(i.salePrice) || 0) * (Number(i.quantity) || 0);
                      existing.totalCost +=
                        (Number(i.purchasePrice) || 0) * (Number(i.quantity) || 0);
                      itemMap.set(i.productId, existing);
                    });
                });

                return Array.from(itemMap.values()).map(item => {
                  const profit = item.totalRev - item.totalCost;
                  const margin =
                    item.totalCost > 0 ? ((profit / item.totalCost) * 100).toFixed(1) : '0.0';

                  return (
                    <tr key={item.productId} className="border-b border-border">
                      <td className="py-3 px-4 font-mono text-xs">—</td>
                      <td className="py-3 px-4 text-muted-foreground">Aggregated</td>
                      <td className="py-3 px-4">
                        {item.productName} (x{item.totalQty})
                      </td>
                      <td className="py-3 px-4 text-right">
                        ${(Number(item.totalRev) || 0).toFixed(2)}
                      </td>
                      <td className="py-3 px-4 text-right text-muted-foreground">
                        ${(Number(item.totalCost) || 0).toFixed(2)}
                      </td>
                      <td className="py-3 px-4 text-right text-success font-medium">
                        ${(Number(profit) || 0).toFixed(2)}
                      </td>
                      <td className="py-3 px-4 text-right font-medium">{margin}%</td>
                      <td className="py-3 px-4 text-muted-foreground">—</td>
                    </tr>
                  );
                });
              })()
            ) : (
              report.filteredSales.map(s => {
                const rev = s.items.reduce(
                  (a, i) => a + (Number(i.salePrice) || 0) * (Number(i.quantity) || 0),
                  0
                );
                const cost = s.items.reduce(
                  (a, i) => a + (Number(i.purchasePrice) || 0) * (Number(i.quantity) || 0),
                  0
                );
                const profit = rev - cost;
                const margin = cost > 0 ? ((profit / cost) * 100).toFixed(1) : '0.0';

                return (
                  <tr key={s.id} className="border-b border-border">
                    <td className="py-3 px-4 font-mono text-xs">#{s.id.slice(-6)}</td>
                    <td className="py-3 px-4 text-muted-foreground">
                      {new Date(s.date).toLocaleString()}
                    </td>
                    <td className="py-3 px-4">
                      {s.items.map(i => `${i.productName} (x${i.quantity})`).join(', ')}
                    </td>
                    <td className="py-3 px-4 text-right">
                      ${(Number(rev) || 0).toFixed(2)}
                    </td>
                    <td className="py-3 px-4 text-right text-muted-foreground">
                      ${(Number(cost) || 0).toFixed(2)}
                    </td>
                    <td className="py-3 px-4 text-right text-success font-medium">
                      ${(Number(profit) || 0).toFixed(2)}
                    </td>
                    <td className="py-3 px-4 text-right font-medium">{margin}%</td>
                    <td className="py-3 px-4 text-muted-foreground">{s.cashierName}</td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {isAdmin && (
        <>
          <div className="mt-8 mb-6">
            <div className="flex items-center gap-3 mb-4">
              <BarChart3 className="text-primary" size={22} />
              <h3 className="text-lg font-bold">Total Sales Summary</h3>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="pos-card p-5">
                <p className="text-sm text-muted-foreground">
                  {userSalesData.dailyLabel} Total Sales
                </p>
                <p className="text-2xl font-bold mt-1">
                  {formatCurrency(userSalesData.dailyTotal, 'USD')}
                </p>
                <p className="text-xs text-muted-foreground mt-1">All users combined</p>
              </div>

              <div className="pos-card p-5">
                <p className="text-sm text-muted-foreground">
                  {userSalesData.monthlyLabel} Total Sales
                </p>
                <p className="text-2xl font-bold mt-1">
                  {formatCurrency(userSalesData.monthlyTotal, 'USD')}
                </p>
                <p className="text-xs text-muted-foreground mt-1">All users combined</p>
              </div>
            </div>
          </div>

          {userSalesData.chartData.length > 0 && (
            <div className="pos-card p-5 mb-6">
              <h4 className="text-sm font-semibold mb-4 text-muted-foreground">
                Sales by User — Today vs This Month
              </h4>

              <ResponsiveContainer width="100%" height={280}>
                <BarChart data={userSalesData.chartData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                  <XAxis dataKey="name" tick={{ fontSize: 12 }} />
                  <YAxis tick={{ fontSize: 12 }} />
                  <Tooltip formatter={(value: number) => `$${(Number(value) || 0).toFixed(2)}`} />
                  <Legend />
                  <Bar dataKey="Today" fill="hsl(var(--primary))" radius={[4, 4, 0, 0]} />
                  <Bar dataKey="This Month" fill="hsl(var(--accent))" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}

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
                        sortBy === s
                          ? 'bg-primary text-primary-foreground'
                          : 'bg-card text-muted-foreground hover:bg-muted'
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
                    <th className="text-right py-3 px-4">Today's Revenue</th>
                    <th className="text-right py-3 px-4">Monthly Sales</th>
                    <th className="text-right py-3 px-4">Monthly Revenue</th>
                    <th className="text-right py-3 px-4">Total Sales</th>
                    <th className="text-right py-3 px-4">Total Revenue</th>
                  </tr>
                </thead>

                <tbody>
                  {userSalesData.byUser.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="text-center py-12 text-muted-foreground">
                        No sales data available
                      </td>
                    </tr>
                  ) : (
                    userSalesData.byUser.map(u => (
                      <tr key={u.name} className="border-b border-border">
                        <td className="py-3 px-4 font-medium">{u.name}</td>
                        <td className="py-3 px-4 text-right">{u.dailySales}</td>
                        <td className="py-3 px-4 text-right">
                          {formatCurrency(u.dailyRev, 'USD')}
                        </td>
                        <td className="py-3 px-4 text-right">{u.monthlySales}</td>
                        <td className="py-3 px-4 text-right">
                          {formatCurrency(u.monthlyRev, 'USD')}
                        </td>
                        <td className="py-3 px-4 text-right font-medium">{u.totalSales}</td>
                        <td className="py-3 px-4 text-right font-bold">
                          {formatCurrency(u.totalRev, 'USD')}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}