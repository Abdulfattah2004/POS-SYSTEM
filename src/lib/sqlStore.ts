// Compatibility paths now use the native SQLite state adapter.
export {
  getProducts as getProductsSql, getProductByBarcode as getProductByBarcodeSql,
  getSales as getSalesSql, addSale as addSaleSql,
  getRefunds as getRefundsSql, addPartialRefund as addPartialRefundSql,
  getExchangeRate as getExchangeRateSql, setExchangeRate as setExchangeRateSql,
  getInventoryEntries as getInventoryEntriesSql, addInventoryEntry as addInventoryEntrySql,
  updateProduct as updateProductSql, deleteProduct as deleteProductSql,
  updateProductStock as updateProductStockSql,
  getUsers as getUsersSql, addUser as addUserSql, deleteUser as deleteUserSql, login as loginSql,
} from './store';
