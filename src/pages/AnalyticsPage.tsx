import { useState, useMemo, useEffect } from 'react';
import { getSalesSql } from '@/lib/sqlStore';
import { Sale } from '@/types/pos';
import { BarChart3 } from 'lucide-react';

export default function AnalyticsPage() {
  const [period, setPeriod] = useState<'daily' | 'monthly'>('daily');
  const [selectedDate, setSelectedDate] = useState(new Date().toISOString().split('T')[0]);
  const [selectedMonth, setSelectedMonth] = useState(new Date().toISOString().slice(0, 7));
  const [sales, setSales] = useState<Sale[]>([]);

  useEffect(() => {
    getSalesSql()
      .then(setSales)
      .catch(error => {
        console.error('Failed to load analytics sales:', error);
        alert('Failed to load analytics sales: ' + error);
      });
  }, []);

  const topItems = useMemo(() => {
    const dateFilter = period === 'daily' ? selectedDate : selectedMonth;
    const filteredSales = sales.filter(s => !s.refunded && (s.date ?? '').startsWith(dateFilter));

    const itemMap = new Map<string, { name: string; quantity: number; revenue: number }>();

    filteredSales.forEach(sale => {
      sale.items.forEach(item => {
        const existing = itemMap.get(item.productId) || {
          name: item.productName,
          quantity: 0,
          revenue: 0,
        };

        existing.quantity += item.quantity;
        existing.revenue += item.salePrice * item.quantity;
        itemMap.set(item.productId, existing);
      });
    });

    return Array.from(itemMap.values()).sort((a, b) => b.quantity - a.quantity);
  }, [period, selectedDate, selectedMonth, sales]);

  const maxQty = Math.max(...topItems.map(i => i.quantity), 1);

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <BarChart3 className="text-primary" size={24} />
          <h2 className="pos-header">Analytics — Most Purchased Items</h2>
        </div>

        <div className="flex items-center gap-3">
          <div className="flex rounded-lg border border-border overflow-hidden">
            {(['daily', 'monthly'] as const).map(p => (
              <button
                key={p}
                onClick={() => setPeriod(p)}
                className={`px-4 py-2 text-sm font-medium capitalize transition-colors ${
                  period === p
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-card text-muted-foreground hover:bg-muted'
                }`}
              >
                {p}
              </button>
            ))}
          </div>

          {period === 'daily' ? (
            <input
              type="date"
              className="pos-input"
              value={selectedDate}
              onChange={e => setSelectedDate(e.target.value)}
            />
          ) : (
            <input
              type="month"
              className="pos-input"
              value={selectedMonth}
              onChange={e => setSelectedMonth(e.target.value)}
            />
          )}
        </div>
      </div>

      {topItems.length === 0 ? (
        <div className="pos-card p-12 text-center text-muted-foreground">
          No sales data for this period
        </div>
      ) : (
        <div className="pos-card p-6 space-y-3">
          {topItems.map((item, i) => (
            <div key={i} className="flex items-center gap-4">
              <span className="w-6 text-right text-sm font-bold text-muted-foreground">
                {i + 1}
              </span>

              <div className="flex-1">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-sm font-medium">{item.name}</span>
                  <span className="text-sm text-muted-foreground">
                    {item.quantity} sold — ${(Number(item.revenue) || 0).toFixed(2)}
                  </span>
                </div>

                <div className="h-2 rounded-full bg-muted overflow-hidden">
                  <div
                    className="h-full rounded-full bg-primary transition-all"
                    style={{ width: `${(item.quantity / maxQty) * 100}%` }}
                  />
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}