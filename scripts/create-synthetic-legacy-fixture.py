"""Create a disposable old-schema pos.db for offline MSI upgrade rehearsal."""
import hashlib
import json
from pathlib import Path
import sqlite3
import sys


def main() -> int:
    if len(sys.argv) != 2:
        raise SystemExit("Usage: python create-synthetic-legacy-fixture.py NEW_EMPTY_OUTPUT_DIRECTORY")
    output = Path(sys.argv[1]).expanduser().resolve()
    if output.exists():
        raise SystemExit("Refusing to overwrite an existing fixture path.")
    output.mkdir(parents=True, exist_ok=False)
    database = output / "pos.db"
    connection = sqlite3.connect(database)
    try:
        connection.execute("PRAGMA journal_mode=DELETE")
        connection.execute("PRAGMA foreign_keys=ON")
        connection.executescript("""
          BEGIN IMMEDIATE;
          CREATE TABLE products (
            id TEXT PRIMARY KEY, barcode TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
            stock_quantity INTEGER NOT NULL, purchase_price REAL NOT NULL,
            sale_price REAL NOT NULL, is_active INTEGER NOT NULL DEFAULT 1
          );
          CREATE TABLE sales (
            id TEXT PRIMARY KEY, subtotal REAL NOT NULL, total REAL NOT NULL,
            currency TEXT NOT NULL, exchange_rate REAL NOT NULL,
            cashier_name TEXT NOT NULL, date TEXT NOT NULL, refunded INTEGER NOT NULL DEFAULT 0
          );
          CREATE TABLE sale_items (
            id TEXT PRIMARY KEY, sale_id TEXT NOT NULL REFERENCES sales(id), product_id TEXT NOT NULL REFERENCES products(id),
            product_name TEXT NOT NULL, barcode TEXT NOT NULL, quantity INTEGER NOT NULL,
            sale_price REAL NOT NULL, purchase_price REAL NOT NULL
          );
          CREATE TABLE refunds (
            id TEXT PRIMARY KEY, sale_id TEXT NOT NULL REFERENCES sales(id), total_refunded REAL NOT NULL,
            currency TEXT NOT NULL, date TEXT NOT NULL, cashier_name TEXT NOT NULL
          );
          CREATE TABLE refund_items (
            id TEXT PRIMARY KEY, refund_id TEXT NOT NULL REFERENCES refunds(id),
            sale_item_id TEXT NOT NULL REFERENCES sale_items(id), product_id TEXT NOT NULL REFERENCES products(id),
            product_name TEXT NOT NULL, barcode TEXT NOT NULL, quantity INTEGER NOT NULL,
            amount REAL NOT NULL, currency TEXT NOT NULL
          );
          CREATE TABLE inventory_entries (
            id TEXT PRIMARY KEY, product_id TEXT REFERENCES products(id), product_name TEXT NOT NULL,
            barcode TEXT NOT NULL, quantity_added INTEGER NOT NULL,
            purchase_price REAL NOT NULL, sale_price REAL NOT NULL,
            salesman_name TEXT NOT NULL, date TEXT NOT NULL
          );
          COMMIT;
        """)
        products = [
            (f"legacy-product-{index:03d}", f"{index + 100000:06d}", f"Synthetic Legacy Product {index + 1:03d}",
             index % 31, round(1.25 + index / 10, 2), round(2.50 + index / 5, 2), 1)
            for index in range(243)
        ]
        connection.executemany("INSERT INTO products VALUES (?, ?, ?, ?, ?, ?, ?)", products)
        sales = [
            (f"legacy-sale-{index:05d}", 2.50, 2.50, "USD", 89500.0, "Synthetic fixture", "2025-01-01T12:00:00Z", 0)
            for index in range(22220)
        ]
        connection.executemany("INSERT INTO sales VALUES (?, ?, ?, ?, ?, ?, ?, ?)", sales)
        sale_items = [
            (f"legacy-item-{index:05d}", f"legacy-sale-{index:05d}", products[index % len(products)][0],
             products[index % len(products)][2], products[index % len(products)][1], 1, 2.50, 1.25)
            for index in range(22220)
        ]
        connection.executemany("INSERT INTO sale_items VALUES (?, ?, ?, ?, ?, ?, ?, ?)", sale_items)
        refunds = [
            (f"legacy-refund-{index:03d}", f"legacy-sale-{index:05d}", 1.0, "USD", "2025-01-02T12:00:00Z", "Synthetic fixture")
            for index in range(15)
        ]
        connection.executemany("INSERT INTO refunds VALUES (?, ?, ?, ?, ?, ?)", refunds)
        connection.executemany(
            "INSERT INTO refund_items VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            [(f"legacy-refund-item-{index:03d}", refund[0], f"legacy-item-{index:05d}",
              products[index % len(products)][0], products[index % len(products)][2],
              products[index % len(products)][1], 1, 1.0, "USD") for index, refund in enumerate(refunds)],
        )
        connection.executemany(
            "INSERT INTO inventory_entries VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            [(f"legacy-entry-{index:03d}", product[0], product[2], product[1], product[3], product[4], product[5],
              "Synthetic fixture", "2025-01-01T08:00:00Z") for index, product in enumerate(products)],
        )
        connection.commit()
        integrity = connection.execute("PRAGMA integrity_check").fetchone()[0]
        foreign_keys = connection.execute("PRAGMA foreign_key_check").fetchall()
        counts = {
            table: connection.execute(f'SELECT count(*) FROM "{table}"').fetchone()[0]
            for table in ("products", "inventory_entries", "sales", "sale_items", "refunds", "refund_items")
        }
        stock_sum = connection.execute("SELECT sum(stock_quantity) FROM products").fetchone()[0]
    finally:
        connection.close()
    if integrity != "ok" or foreign_keys or counts["products"] != 243 or counts["sales"] != 22220 or counts["refunds"] != 15:
        raise SystemExit("Synthetic legacy fixture verification failed.")
    digest = hashlib.sha256(database.read_bytes()).hexdigest()
    manifest = {
        "label": "SYNTHETIC LEGACY TEST DATA ONLY",
        "database": database.name,
        "sha256": digest,
        "integrity": integrity,
        "foreignKeyViolations": len(foreign_keys),
        "counts": counts,
        "stockQuantitySum": stock_sum,
        "branchColumnsPresent": False,
        "customerData": False,
        "productionData": False,
    }
    (output / "FIXTURE-MANIFEST.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(manifest))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
