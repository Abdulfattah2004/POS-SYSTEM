use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

fn rows<'a>(branch: &'a Value, field: &str) -> Result<&'a Vec<Value>, String> {
    branch[field]
        .as_array()
        .ok_or_else(|| format!("Invalid local {field}"))
}
fn indexed<'a>(values: &'a [Value]) -> Result<BTreeMap<&'a str, &'a Value>, String> {
    let mut result = BTreeMap::new();
    for row in values {
        let id = row["id"]
            .as_str()
            .filter(|id| !id.is_empty())
            .ok_or("Invalid record identifier")?;
        if result.insert(id, row).is_some() {
            return Err("Duplicate record identifier".into());
        }
    }
    Ok(result)
}
fn immutable(old: &[Value], new: &[Value]) -> Result<(), String> {
    let next = indexed(new)?;
    for row in old {
        let id = row["id"].as_str().ok_or("Invalid historical identifier")?;
        if next.get(id).copied() != Some(row) {
            return Err("Existing financial records cannot be edited or removed".into());
        }
    }
    Ok(())
}
fn number(row: &Value, field: &str) -> Result<f64, String> {
    row[field]
        .as_f64()
        .filter(|n| n.is_finite() && *n >= 0.0)
        .ok_or_else(|| format!("Invalid financial {field}"))
}
fn quantity(line: &Value) -> Result<i64, String> {
    line["quantity"]
        .as_i64()
        .filter(|n| *n > 0 && *n <= 2147483647)
        .ok_or_else(|| "Invalid financial quantity".into())
}
fn total(record: &Value, field: &str) -> Result<(), String> {
    let items = rows(record, "items")?;
    if items.is_empty() {
        return Err("Financial items are required".into());
    }
    let mut seen = BTreeSet::new();
    let mut sum = 0.0;
    for item in items {
        let id = item["productId"]
            .as_str()
            .ok_or("Financial product identity required")?;
        if !seen.insert(id) {
            return Err("Duplicate financial line".into());
        }
        sum += quantity(item)? as f64 * number(item, "salePrice")?;
        number(item, "purchasePrice")?;
    }
    let subtotal = ((sum + f64::EPSILON) * 100.0).round() / 100.0;
    let expected = match record["currency"].as_str() {
        Some("USD") => subtotal,
        Some("LBP") => {
            let rate = number(record, "exchangeRate")?;
            if rate <= 0.0 {
                return Err("Invalid exchange rate".into());
            }
            (subtotal * rate).round()
        }
        _ => return Err("Invalid settlement currency".into()),
    };
    if !expected.is_finite()
        || expected > 90071992547409.91
        || (number(record, field)? - expected).abs() > 0.000001
    {
        return Err("Financial settlement does not match its items".into());
    }
    if field == "total" && (number(record, "subtotal")? - subtotal).abs() > 0.000001 {
        return Err("Sale subtotal does not match its items".into());
    }
    Ok(())
}

// A native session's SQL role is checked independently of frontend role data.
// Financial history is append-only for every role. Cashier catalog changes
// are limited to stock deltas justified by valid newly appended sales/refunds.
pub(crate) fn validate(old: &Value, new: &Value, admin: bool, actor: &str) -> Result<(), String> {
    let previous = old["branches"]
        .as_object()
        .ok_or("Invalid previous branch data")?;
    let next = new["branches"]
        .as_object()
        .ok_or("Invalid next branch data")?;
    if !admin && previous.keys().collect::<Vec<_>>() != next.keys().collect::<Vec<_>>() {
        return Err("Administrator authorization required for branch changes".into());
    }
    for (key, before) in previous {
        let after = next
            .get(key)
            .ok_or("Existing branch records cannot be removed")?;
        if before == after {
            continue;
        }
        let old_sales = rows(before, "sales")?;
        let sales = rows(after, "sales")?;
        let old_refunds = rows(before, "refunds")?;
        let refunds = rows(after, "refunds")?;
        immutable(old_sales, sales)?;
        immutable(old_refunds, refunds)?;
        let old_sale_ids = indexed(old_sales)?;
        let old_refund_ids = indexed(old_refunds)?;
        let products = indexed(rows(before, "products")?)?;
        let old_ops=old["outbox"].as_array();
        let local_settlement=new["outbox"].as_array().is_some_and(|ops|ops.iter().any(|op|
            matches!(op["type"].as_str(),Some("sale"|"refund"|"refund_batch")) &&
            !old_ops.is_some_and(|previous|previous.iter().any(|p|p["operationId"]==op["operationId"]))));
        let mut deltas = BTreeMap::<&str, i64>::new();
        for sale in sales
            .iter()
            .filter(|s| !old_sale_ids.contains_key(s["id"].as_str().unwrap_or("")))
        {
            if sale["legacy"] == true {
                if !admin {
                    return Err("Administrator authorization required for historical import".into());
                }
                continue;
            }
            total(sale, "total")?;
            for line in rows(sale, "items")? {
                let id = line["productId"]
                    .as_str()
                    .ok_or("Sale product identity required")?;
                if !admin || local_settlement {
                    let p = products.get(id).ok_or("Sale product not available")?;
                    if p["isActive"] == false
                        || p["salePrice"] != line["salePrice"]
                        || p["purchasePrice"] != line["purchasePrice"]
                    {
                        return Err("Sale product or price changed".into());
                    }
                }
                *deltas.entry(id).or_default() -= quantity(line)?;
            }
        }
        let parents = indexed(sales)?;
        let mut returned = BTreeMap::<(&str, &str), i64>::new();
        for refund in refunds {
            if refund["legacy"] == true {
                if !admin && !old_refund_ids.contains_key(refund["id"].as_str().unwrap_or("")) {
                    return Err("Administrator authorization required for historical import".into());
                }
                continue;
            }
            let parent_id = refund["saleId"].as_str().ok_or("Refund parent required")?;
            let parent = parents.get(parent_id).ok_or("Refund parent missing")?;
            if parent["legacy"] == true {
                if old_refund_ids.contains_key(refund["id"].as_str().unwrap_or("")) {
                    continue;
                }
                return Err("Historical refund requires reviewed reconciliation".into());
            }
            for line in rows(refund, "items")? {
                let id = line["productId"]
                    .as_str()
                    .ok_or("Refund product identity required")?;
                let sold = rows(parent, "items")?
                    .iter()
                    .find(|item| item["productId"] == line["productId"])
                    .ok_or("Refund item not sold")?;
                if sold["salePrice"] != line["salePrice"]
                    || sold["purchasePrice"] != line["purchasePrice"]
                {
                    return Err("Refund prices differ from original sale".into());
                }
                let count = returned.entry((parent_id, id)).or_default();
                *count += quantity(line)?;
                if *count > quantity(sold)? {
                    return Err("Refund exceeds original sold quantity".into());
                }
                if !old_refund_ids.contains_key(refund["id"].as_str().unwrap_or("")) {
                    *deltas.entry(id).or_default() += quantity(line)?;
                }
            }
            if !old_refund_ids.contains_key(refund["id"].as_str().unwrap_or("")) {
                total(refund, "totalRefunded")?;
            }
        }
        if admin {
            if local_settlement && !deltas.is_empty() {
                let updated=indexed(rows(after,"products")?)?;
                if products.keys().collect::<Vec<_>>()!=updated.keys().collect::<Vec<_>>() { return Err("Checkout cannot change the product catalog".into()); }
                for (id,p) in &products {
                    let next=updated[id];
                    let old_stock=p["stockQuantity"].as_i64().ok_or("Invalid stock")?;
                    let stock=next["stockQuantity"].as_i64().filter(|n|*n>=-2147483648 && *n<=2147483647).ok_or("Invalid stock")?;
                    if stock-old_stock!=*deltas.get(id).unwrap_or(&0) { return Err("Checkout and refunds require atomic matching inventory changes".into()); }
                    if after["allowNegativeStock"]==false && stock<0 && stock<old_stock {return Err("Stock policy prevents overselling".into());}
                }
                if deltas.keys().any(|id|!products.contains_key(id)) {return Err("Checkout product identity is not in branch inventory".into());}
            }
            continue;
        }
        let scope = old["association"]
            .as_object()
            .and_then(|a| {
                Some(format!(
                    "{}/{}",
                    a.get("businessId")?.as_str()?,
                    a.get("branchId")?.as_str()?
                ))
            })
            .unwrap_or("unassigned".into());
        if key != &scope {
            return Err("Cashier cannot change another branch".into());
        }
        for (field, value) in before.as_object().ok_or("Invalid branch")? {
            if !["products", "sales", "refunds", "heldSales", "completed"].contains(&field.as_str())
                && after.get(field) != Some(value)
            {
                return Err(
                    "Administrator authorization required for inventory or settings changes".into(),
                );
            }
        }
        for field in after.as_object().ok_or("Invalid branch")?.keys() {
            if before.get(field).is_none() && field != "heldSales" {
                return Err("Administrator authorization required for branch configuration".into());
            }
        }
        let new_products = indexed(rows(after, "products")?)?;
        if products.keys().collect::<Vec<_>>() != new_products.keys().collect::<Vec<_>>() {
            return Err("Administrator authorization required for catalog changes".into());
        }
        for (id, product) in products {
            let updated = new_products[id];
            let mut original = product.as_object().ok_or("Invalid product")?.clone();
            let mut candidate = updated.as_object().ok_or("Invalid product")?.clone();
            original.remove("stockQuantity");
            candidate.remove("stockQuantity");
            if original != candidate {
                return Err("Administrator authorization required for catalog changes".into());
            }
            let old_stock = product["stockQuantity"].as_i64().ok_or("Invalid stock")?;
            let new_stock = updated["stockQuantity"]
                .as_i64()
                .filter(|n| *n >= -2147483648 && *n <= 2147483647)
                .ok_or("Invalid stock")?;
            if new_stock - old_stock != *deltas.get(id).unwrap_or(&0) {
                return Err("Cashier stock changes require matching sale or refund records; ask an administrator to refresh remote inventory".into());
            }
            if after["allowNegativeStock"] == false && new_stock < 0 && new_stock < old_stock {
                return Err("Stock policy prevents overselling".into());
            }
        }
        let empty = Vec::new();
        let old_holds = before["heldSales"].as_array().unwrap_or(&empty);
        let new_holds = after["heldSales"].as_array().unwrap_or(&empty);
        let existing = indexed(old_holds)?;
        let incoming = indexed(new_holds)?;
        for (id, hold) in &existing {
            if hold["userId"] != actor && incoming.get(id).copied() != Some(*hold) {
                return Err(
                    "Only the original cashier or an administrator can change this held cart"
                        .into(),
                );
            }
        }
        for (id, hold) in incoming {
            if existing.get(id).copied() != Some(hold) && hold["userId"] != actor {
                return Err("Held cart owner must match the signed-in cashier".into());
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn state() -> Value {
        json!({"association":null,"branches":{"unassigned":{"products":[{"id":"p","name":"Coffee","salePrice":4,"purchasePrice":1,"stockQuantity":10}],"sales":[],"refunds":[],"entries":[],"completed":{},"exchangeRate":89500}}})
    }
    fn sale() -> Value {
        json!({"id":"sale","items":[{"productId":"p","quantity":2,"salePrice":4,"purchasePrice":1}],"subtotal":8,"total":8,"currency":"USD","exchangeRate":89500})
    }
    #[test]
    fn cashier_cannot_forge_catalog_settings_or_stock() {
        let old = state();
        for field in ["name", "salePrice", "stockQuantity"] {
            let mut new = old.clone();
            new["branches"]["unassigned"]["products"][0][field] = json!(7);
            assert!(validate(&old, &new, false, "cashier").is_err());
        }
        let mut new = old.clone();
        new["branches"]["unassigned"]["exchangeRate"] = json!(1);
        assert!(validate(&old, &new, false, "cashier").is_err());
    }
    #[test]
    fn valid_cashier_sale_and_refund_stock_deltas_pass() {
        let old = state();
        let mut sold = old.clone();
        sold["branches"]["unassigned"]["sales"] = json!([sale()]);
        sold["branches"]["unassigned"]["products"][0]["stockQuantity"] = json!(8);
        validate(&old, &sold, false, "cashier").unwrap();
        let mut returned = sold.clone();
        returned["branches"]["unassigned"]["refunds"] = json!([{"id":"refund","saleId":"sale","items":[{"productId":"p","quantity":1,"salePrice":4,"purchasePrice":1}],"totalRefunded":4,"currency":"USD","exchangeRate":89500}]);
        returned["branches"]["unassigned"]["products"][0]["stockQuantity"] = json!(9);
        validate(&sold, &returned, false, "cashier").unwrap();
    }
    #[test]
    fn financial_history_is_immutable_even_for_admin() {
        let mut old = state();
        old["branches"]["unassigned"]["sales"] = json!([sale()]);
        let mut new = old.clone();
        new["branches"]["unassigned"]["sales"][0]["total"] = json!(100);
        assert!(validate(&old, &new, true, "admin").is_err());
        new["branches"]["unassigned"]["sales"] = json!([]);
        assert!(validate(&old, &new, true, "admin").is_err());
    }
    #[test]
    fn cloud_refresh_must_preserve_line_order_and_local_provenance_exactly() {
        let mut old = state();
        let mut original = sale();
        original["items"] = json!([
            {"productId":"z","quantity":1,"salePrice":4,"purchasePrice":1},
            {"productId":"a","quantity":1,"salePrice":4,"purchasePrice":1}
        ]);
        old["branches"]["unassigned"]["sales"] = json!([original]);
        let mut reordered = old.clone();
        reordered["branches"]["unassigned"]["sales"][0]["items"].as_array_mut().unwrap().reverse();
        assert_eq!(validate(&old, &reordered, true, "admin").unwrap_err(), "Existing financial records cannot be edited or removed");
        let mut marked = old.clone();
        marked["branches"]["unassigned"]["sales"][0]["legacy"] = json!(false);
        assert!(validate(&old, &marked, true, "admin").is_err());
        let mut compatible = old.clone();
        compatible["branches"]["unassigned"]["products"][0]["stockQuantity"] = json!(9);
        validate(&old, &compatible, true, "admin").unwrap();
        assert_eq!(compatible["branches"]["unassigned"]["sales"], old["branches"]["unassigned"]["sales"]);
    }
    #[test]
    #[ignore = "requires a verified customer-derived temporary financial fixture"]
    fn verified_customer_refresh_copy_reproduces_failure_and_preserves_sqlite_restart() {
        use sqlx::{Connection, SqliteConnection};
        let path = std::path::PathBuf::from(std::env::var_os("SWIFT_TILL_REFRESH_REPAIR_JSON").expect("Provide the verified COPY fixture")).canonicalize().unwrap();
        let directory = path.parent().unwrap();
        let temp = std::env::temp_dir().canonicalize().unwrap();
        assert_eq!(directory.parent(), Some(temp.as_path()));
        assert!(directory.file_name().unwrap().to_string_lossy().starts_with("swift-till-refresh-repair-copy-"));
        assert!(directory.join(".swift-till-synthetic-profile").is_file());
        let fixture:Value=serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(validate(&fixture["old"],&fixture["reordered"],true,"copy-admin").unwrap_err(),"Existing financial records cannot be edited or removed");
        validate(&fixture["old"],&fixture["compatible"],true,"copy-admin").unwrap();
        tauri::async_runtime::block_on(async {
            let database=directory.join("validated-copy.db");
            assert!(!database.exists(),"Never overwrite a previous test database");
            let mut conn=crate::initialization::connect(&database).await.unwrap();
            sqlx::query(include_str!("../migrations/003_durable_state.sql")).execute(&mut conn).await.unwrap();
            assert!(crate::state_store::compare_and_swap(&mut conn,-1,&fixture["old"]).await.unwrap());
            assert!(crate::state_store::compare_and_swap(&mut conn,0,&fixture["compatible"]).await.unwrap());
            conn.close().await.unwrap();
            let mut reopened=SqliteConnection::connect_with(&sqlx::sqlite::SqliteConnectOptions::new().filename(&database).read_only(true)).await.unwrap();
            let actual=crate::state_store::read_state(&mut reopened).await.unwrap().unwrap();
            assert_eq!(actual["branches"],fixture["old"]["branches"]);
            assert_eq!(sqlx::query_scalar::<_,String>("PRAGMA integrity_check").fetch_one(&mut reopened).await.unwrap(),"ok");
            reopened.close().await.unwrap();
        });
    }
    #[test]
    fn forged_refund_totals_and_excessive_refunds_are_rejected() {
        let mut old = state();
        old["branches"]["unassigned"]["sales"] = json!([sale()]);
        for (qty, total) in [(1, 999), (3, 12)] {
            let mut new = old.clone();
            new["branches"]["unassigned"]["refunds"] = json!([{"id":"r","saleId":"sale","items":[{"productId":"p","quantity":qty,"salePrice":4,"purchasePrice":1}],"totalRefunded":total,"currency":"USD","exchangeRate":89500}]);
            assert!(validate(&old, &new, true, "admin").is_err());
        }
    }
    #[test]
    fn cashier_holds_cannot_change_another_cashiers_cart() {
        let mut old = state();
        old["branches"]["unassigned"]["heldSales"] = json!([{"id":"hold","userId":"other"}]);
        let mut new = old.clone();
        new["branches"]["unassigned"]["heldSales"] = json!([]);
        assert!(validate(&old, &new, false, "cashier").is_err());
        validate(&old, &new, true, "admin").unwrap();
    }
    #[test]
    fn cashier_can_hold_without_stock_or_revenue_effects() {
        let old = state();
        let mut new = old.clone();
        new["branches"]["unassigned"]["heldSales"] = json!([{"id":"hold","userId":"cashier"}]);
        validate(&old, &new, false, "cashier").unwrap();
    }
}
