import { businessDate, movements } from '@/lib/accounting';
import { useState, useMemo } from 'react';
import { getSales, getRefunds, formatCurrency } from '@/lib/store';
import { TrendingUp } from 'lucide-react';

export default function DailyMovementPage() {
  const [selectedDate, setSelectedDate] = useState(businessDate());

  const sales = getSales();
  const refunds = getRefunds();

  const movement = useMemo(() => movements(sales, refunds, date => date === selectedDate), [selectedDate, sales, refunds]);

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

      {/* Summary Cards */}
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

      {/* Items Table */}
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
                <td colSpan={6} className="text-center py-12 text-muted-foreground">No sales for this date</td>
              </tr>
            ) : movement.items.map((item, i) => {
              const profit = item.revenue - item.cost;
              const margin = item.cost > 0 ? ((profit / item.cost) * 100) : 0;
              return (
                <tr key={i} className="border-b border-border">
                  <td className="py-3 px-4 font-medium">{item.name}</td>
                  <td className="py-3 px-4 text-right">{item.quantity}</td>
                  <td className="py-3 px-4 text-right">${item.revenue.toFixed(2)}</td>
                  <td className="py-3 px-4 text-right text-muted-foreground">${item.cost.toFixed(2)}</td>
                  <td className="py-3 px-4 text-right text-success font-medium">${profit.toFixed(2)}</td>
                  <td className="py-3 px-4 text-right font-medium">{margin.toFixed(1)}%</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
