import type { Sale, Refund } from '@/types/pos';
const dateFormatters = new Map<string,Intl.DateTimeFormat>();
export function businessDate(value: string | Date = new Date(), timezone = 'Asia/Beirut'): string {
  let formatter=dateFormatters.get(timezone);
  if(!formatter){formatter=new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' });dateFormatters.set(timezone,formatter);}
  const parts = formatter.formatToParts(new Date(value));
  const part = (name: string) => parts.find(part => part.type === name)!.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}
export function movements(sales: Sale[], refunds: Refund[], matches: (date: string) => boolean, query = '') {
  const items = new Map<string, { name: string; quantity: number; revenue: number; cost: number }>();
  const include = (item: { productName: string; barcode: string }) => !query || item.productName.toLowerCase().includes(query.toLowerCase()) || item.barcode.toLowerCase().includes(query.toLowerCase());
  const verifiedSaleIds = new Set(sales.filter(sale => !sale.legacy).map(sale => sale.id));
  const filteredSales = sales.filter(sale => !sale.legacy && matches(businessDate(sale.date)) && sale.items.some(include));
  const filteredRefunds = refunds.filter(refund => verifiedSaleIds.has(refund.saleId) && matches(businessDate(refund.date)) && refund.items.some(include));
  let grossRevenue = 0; let totalRefunded = 0;
  for (const [records, sign] of [[filteredSales, 1], [filteredRefunds, -1]] as const) {
    for (const record of records) for (const line of record.items.filter(include)) {
      const item = items.get(line.productId) ?? { name: line.productName, quantity: 0, revenue: 0, cost: 0 };
      item.quantity += sign * line.quantity; item.revenue += sign * line.salePrice * line.quantity; item.cost += sign * line.purchasePrice * line.quantity;
      items.set(line.productId, item);
      if (sign === 1) grossRevenue += line.salePrice * line.quantity;
      else totalRefunded += line.salePrice * line.quantity;
    }
  }
  const rows = Array.from(items.values());
  const totalRevenue = rows.reduce((sum, item) => sum + item.revenue, 0);
  const totalCost = rows.reduce((sum, item) => sum + item.cost, 0);
  const totalProfit = totalRevenue - totalCost;
  return { items: rows, filteredSales, filteredRefunds, totalRevenue, totalSales: totalRevenue, grossRevenue, totalCost, totalProfit, totalRefunded, numSales: filteredSales.length, numRefunds: filteredRefunds.length, marginPercent: totalRevenue > 0 ? totalProfit / totalRevenue * 100 : 0 };
}
export function csv(rows: (string | number)[][]): string {
  return rows.map(row => row.map(value => {
    let text = String(value);
    if (typeof value === 'string' && /^[\s]*[=+@-]/.test(text)) text = "'" + text;
    return '"' + text.replace(/"/g, '""') + '"';
  }).join(',')).join('\r\n');
}
