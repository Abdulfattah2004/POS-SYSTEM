import { businessDate, movements } from '@/lib/accounting';
import { useState, useMemo } from 'react';
import LocalReportScope from '@/components/LocalReportScope';
import type {Sale,Refund} from '@/types/pos';
import { BarChart3 } from 'lucide-react';

export default function AnalyticsPage() {
  return <LocalReportScope analytics>{(sales,refunds)=><VerifiedAnalytics sales={sales} refunds={refunds}/>}</LocalReportScope>;
}
function VerifiedAnalytics({sales,refunds}:{sales:Sale[];refunds:Refund[]}) {
  const [period, setPeriod] = useState<'daily' | 'monthly'>('daily');
  const [selectedDate, setSelectedDate] = useState(businessDate());
  const [selectedMonth, setSelectedMonth] = useState(businessDate().slice(0, 7));


  const topItems = useMemo(() => {
    const dateFilter = period === 'daily' ? selectedDate : selectedMonth;
    return movements(sales, refunds, date => date.startsWith(dateFilter)).items
      .filter(item => item.quantity > 0).sort((a, b) => b.quantity - a.quantity).slice(0, 20);
  }, [period, selectedDate, selectedMonth, sales, refunds]);

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
                  period === p ? 'bg-primary text-primary-foreground' : 'bg-card text-muted-foreground hover:bg-muted'
                }`}
              >
                {p}
              </button>
            ))}
          </div>
          {period === 'daily' ? (
            <input type="date" className="pos-input" value={selectedDate} onChange={e => setSelectedDate(e.target.value)} />
          ) : (
            <input type="month" className="pos-input" value={selectedMonth} onChange={e => setSelectedMonth(e.target.value)} />
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
              <span className="w-6 text-right text-sm font-bold text-muted-foreground">{i + 1}</span>
              <div className="flex-1">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-sm font-medium">{item.name}</span>
                  <span className="text-sm text-muted-foreground">{item.quantity} sold — ${item.revenue.toFixed(2)}</span>
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
