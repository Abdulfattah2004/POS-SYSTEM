import { useState, useMemo, useEffect } from 'react';
import { formatCurrency } from '@/lib/store';
import { getSalesSql, getRefundsSql } from '@/lib/sqlStore';
import { Sale, Refund } from '@/types/pos';
import { TrendingUp } from 'lucide-react';

export default function DailyMovementPage() {
  const [selectedDate, setSelectedDate] = useState(new Date().toISOString().split('T')[0]);
  const [sales, setSales] = useState<Sale[]>([]);
  const [refunds, setRefunds] = useState<Refund[]>([]);

  useEffect(() => {
    async function loadData() {
      setSales(await getSalesSql());
      setRefunds(await getRefundsSql());
    }

    loadData().catch(error => {
      console.error('Failed to load daily movement:', error);
      alert('Failed to load daily movement: ' + error);
    });
  }, []);

  const movement = useMemo(() => {
    const daySales = sales.filter(s => !s.refunded && (s.date ?? '').startsWith(selectedDate));
    const dayRefunds = refunds.filter(r => (r.date ?? '').startsWith(selectedDate));

    const itemMap = new Map<string, { name: string; quantity: number; revenue: number; cost: number }>();

    daySales.forEach(sale => {
      sale.items.forEach(item => {
        const key = item.productId;
        const existing = itemMap.get(key) || {
          name: item.productName,
          quantity: 0,
          revenue: 0,
          cost: 0,
        };

        existing.quantity += item.quantity;
        existing.revenue += item.salePrice * item.quantity;
        existing.cost += item.purchasePrice * item.quantity;
        itemMap.set(key, existing);
      });
    });

    dayRefunds.forEach(refund => {
      refund.items.forEach(item => {
        const existing = itemMap.get(item.productId);

        if (existing) {
          existing.quantity -= item.quantity;
          existing.revenue -= item.salePrice * item.quantity;
          existing.cost -= item.purchasePrice * item.quantity;
        }
      });
    });

    const items = Array.from(itemMap.values()).filter(i => i.quantity > 0);
    const totalSales = items.reduce((s, i) => s + i.revenue, 0);
    const totalCost = items.reduce((s, i) => s + i.cost, 0);
    const totalProfit = totalSales - totalCost;

    return { items, totalSales, totalCost, totalProfit };
  }, [selectedDate, sales, refunds]);

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <TrendingUp className="text-primary" size={24} />
          <h2 className="pos-header">Daily Movement</h2>
        </div>

        <input
          type="date"
          className="pos-input"
          value={selectedDate}
          onChange={e => setSelectedDate(e.target.value)}
        />
      </div>

      <div className="grid grid-cols-3 gap-4 mb-6">
        {[
          { label: 'Total Sales', value: formatCurrency(movement.totalSales, 'USD'), color: 'text-primary' },
          { label: 'Total Cost', value: formatCurrency(movement.totalCost, 'USD'), color: 'text-muted-foreground' },
          { label: 'Total Profit', value: formatCurrency(movement.totalProfit, 'USD'), color: 'text-success' },
        ].map(c => (
          <div key={c.label} className="pos-card p-4">
            <p className="text-sm text-muted-foreground">{c.label}</p>
            <p className={`text-2xl font-bold mt-1 ${c.color}`}>{c.value}</p>
          </div>
        ))}
      </div>

      <div className="pos-card overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="pos-table-header">
              <th className="text-left py-3 px-4">Item</th>
              <th className="text-right py-3 px-4">Qty Sold</th>
              <th className="text-right py-3 px-4">Revenue</th>
              <th className="text-right py-3 px-4">Cost</th>
              <th className="text-right py-3 px-4">Profit</th>
              <th className="text-right py-3 px-4">Margin %</th>
            </tr>
          </thead>

          <tbody>
            {movement.items.length === 0 ? (
              <tr>
                <td colSpan={6} className="text-center py-12 text-muted-foreground">
                  No sales for this date
                </td>
              </tr>
            ) : (
              movement.items.map((item, i) => {
                const profit = (Number(item.revenue) || 0) - (Number(item.cost) || 0);
                const margin = (Number(item.cost) || 0) > 0 ? (profit / item.cost) * 100 : 0;

                return (
                  <tr key={i} className="border-b border-border">
                    <td className="py-3 px-4 font-medium">{item.name}</td>
                    <td className="py-3 px-4 text-right">{item.quantity}</td>
                    <td className="py-3 px-4 text-right">${(Number(item.revenue) || 0).toFixed(2)}</td>
                    <td className="py-3 px-4 text-right text-muted-foreground">${(Number(item.cost) || 0).toFixed(2)}</td>
                    <td className="py-3 px-4 text-right text-success font-medium">${(Number(profit) || 0).toFixed(2)}</td>
                    <td className="py-3 px-4 text-right font-medium">{(Number(margin) || 0).toFixed(1)}%</td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}