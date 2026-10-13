export type UserRole = 'admin' | 'cashier';

export interface User {
  requiresPasswordChange?: boolean;
  id: string;
  username: string;
  role: UserRole;
  name: string;
}

export interface Product {
  legacy?: boolean;
  isActive?: boolean;
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
export interface HeldSale {
  id: string;
  label: string;
  createdAt: string;
  userId: string;
  cashierName: string;
  currency: Currency;
  items: { productId: string; quantity: number; salePrice: number }[];
}

export type Currency = 'USD' | 'LBP';

export interface Sale {
  id: string;
  legacy?: boolean;
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
  legacy?: boolean;
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
  legacy?: boolean;
  saleId: string;
  items: RefundItem[];
  totalRefunded: number;
  currency: Currency;
  date: string;
  cashierName: string;
  exchangeRate?: number;
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
