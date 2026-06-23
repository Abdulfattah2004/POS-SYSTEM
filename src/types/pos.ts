export type UserRole = 'admin' | 'cashier';

export interface User {
  id: string;
  username: string;
  password: string;
  role: UserRole;
  name: string;
}

export interface Product {
  id: string;
  barcode: string;
  name: string;
  stockQuantity: number;
  purchasePrice: number;
  salePrice: number;
}

export interface CartItem {
  product: Product;
  quantity: number;
}

export type Currency = 'USD' | 'LBP';

export interface Sale {
  id: string;
  items: SaleItem[];
  subtotal: number;
  total: number;
  currency: Currency;
  exchangeRate: number;
  cashierName: string;
  date: string;
  refunded: boolean;
}

export interface SaleItem {
  productId: string;
  productName: string;
  barcode: string;
  quantity: number;
  salePrice: number;
  purchasePrice: number;
  currency: Currency;
}

export interface InventoryEntry {
  id: string;
  productId: string;
  productName: string;
  barcode: string;
  quantityAdded: number;
  purchasePrice: number;
  salePrice: number;
  salesmanName: string;
  date: string;
}

export interface Refund {
  id: string;
  saleId: string;
  items: RefundItem[];
  totalRefunded: number;
  currency: Currency;
  date: string;
  cashierName: string;
}

export interface RefundItem {
  productId: string;
  productName: string;
  barcode: string;
  quantity: number;
  salePrice: number;
  purchasePrice: number;
  currency: Currency;
}

export interface DailyMovement {
  date: string;
  itemsSold: { name: string; quantity: number; revenue: number; cost: number; profit: number; profitPercent: number }[];
  totalSales: number;
  totalCost: number;
  totalProfit: number;
}
