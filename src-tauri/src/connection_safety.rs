use serde_json::Value;

const PAUSED: &str = "Connection management is separate from historical attribution. Checkout, inventory changes and synchronization are blocked until reviewed attribution";

fn has_records(branch: &Value) -> bool {
    ["products", "entries", "sales", "refunds", "heldSales"]
        .iter().any(|field| branch[field].as_array().is_some_and(|rows| !rows.is_empty()))
}

// Enforce connection/data separation at native IPC as well as in React.
// Reviewed recovery uses its separate verified-backup transaction, not this API.
pub(crate) fn validate(old: &Value, new: &Value) -> Result<(), String> {
    if old["inventoryActivation"] != new["inventoryActivation"] { return Err("Inventory ownership proof requires verified backup review".into()); }
    let connected = !old["association"].is_null() || !new["association"].is_null() || old["inventoryActivation"].is_object();
    let pending = old["legacyBranchRecovery"]["reconciliationPending"] == true;
    if !pending && !(connected && has_records(&old["branches"]["unassigned"])) { return Ok(()); }
    let business = new["association"]["businessId"].as_str().unwrap_or("");
    let branch = new["association"]["branchId"].as_str().unwrap_or("");
    let selected = format!("{business}/{branch}");
    let original = &old["branches"]["unassigned"];
    let inventory_pending = ["products", "entries", "heldSales"].iter()
        .any(|field| original[field].as_array().is_some_and(|rows| !rows.is_empty()));
    let verified = old["inventoryActivation"]["businessId"] == new["association"]["businessId"]
        && old["inventoryActivation"]["branchId"] == new["association"]["branchId"]
        && old["inventoryActivation"].is_object();
    let trading = !pending && (!inventory_pending || verified);
    for field in ["project1Settings", "legacyStorageArchive", "legacyBranchRecovery", "inventoryActivation"] {
        if old[field] != new[field] { return Err(PAUSED.into()); }
    }
    if !trading {
        for field in ["outbox", "pendingRequests"] {
            if old[field] != new[field] { return Err(PAUSED.into()); }
        }
    } else {
        // Existing ambiguous operations never become eligible through activation.
        let protected = old["inventoryActivation"]["historicalOperationIds"].as_array();
        let before_ops = old["outbox"].as_array().ok_or("Invalid original queue")?;
        let after_ops = new["outbox"].as_array().ok_or("Invalid saved queue")?;
        let scoped = |op: &Value| op["businessId"] == new["association"]["businessId"] && op["branchId"] == new["association"]["branchId"];
        for op in before_ops {
            if !scoped(op) || op["protocolRevision"]!=3 || protected.is_some_and(|ids| ids.contains(&op["operationId"])) {
                if after_ops.iter().filter(|next| next["operationId"] == op["operationId"]).collect::<Vec<_>>() != vec![op] { return Err(PAUSED.into()); }
            }
        }
        for op in after_ops {
            if !scoped(op) && !before_ops.contains(op) { return Err(PAUSED.into()); }
        }
        let old_requests = old["pendingRequests"].as_object();
        let new_requests = new["pendingRequests"].as_object();
        for (key,value) in old_requests.into_iter().flatten() {
            if !key.ends_with(&selected) && new_requests.and_then(|r|r.get(key)) != Some(value) { return Err(PAUSED.into()); }
        }
        for (key,value) in new_requests.into_iter().flatten() {
            if !key.ends_with(&selected) && old_requests.and_then(|r|r.get(key)) != Some(value) { return Err(PAUSED.into()); }
        }
    }
    let before = old["branches"].as_object().ok_or("Invalid original branches")?;
    let after = new["branches"].as_object().ok_or("Invalid saved branches")?;
    for (key, branch) in before {
        if !(trading && key == &selected) && after.get(key) != Some(branch) { return Err(PAUSED.into()); }
    }
    for (key, added) in after.iter().filter(|(key, _)| !before.contains_key(*key)) {
        if business.is_empty() || branch.is_empty() || key != &selected || has_records(added)
            || ["products", "entries", "sales", "refunds"].iter().any(|field| added[field].as_array().map_or(true, |rows| !rows.is_empty()))
            || added["completed"].as_object().map_or(true, |rows| !rows.is_empty())
            || added["productAliases"].as_object().is_some_and(|rows| !rows.is_empty()) {
            return Err(PAUSED.into());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use sqlx::Connection;
    use rand_core::RngCore;
    fn empty() -> Value { json!({"products":[],"entries":[],"sales":[],"refunds":[],"completed":{},"exchangeRate":89500,"allowNegativeStock":true}) }
    fn original() -> Value {
        let mut bucket = empty();
        bucket["products"] = json!((0..243).map(|i| json!({"id":format!("p-{i}"),"stockQuantity":10})).collect::<Vec<_>>());
        bucket["sales"] = json!((0..22220).map(|i| json!({"id":format!("s-{i}"),"legacy":true,"total":2})).collect::<Vec<_>>());
        json!({"version":2,"revision":0,"association":null,"branches":{"unassigned":bucket},"outbox":[{"operationId":"original-pending"}],"project1Settings":{},"legacyStorageArchive":{"pos_sales":"preserved"}})
    }
    fn connection(old: &Value, branch: &str) -> Value {
        let mut new = old.clone();
        new["association"] = json!({"businessId":"daily","branchId":branch,"ownerUserId":"owner","businessName":"Daily Supermarket","branchName":branch});
        new["branches"][format!("daily/{branch}")] = empty();
        new["revision"] = json!(old["revision"].as_i64().unwrap()+1);
        new
    }
    #[test]
    fn saves_and_switches_connection_without_reassigning_243_products_or_22220_sales() {
        let old = original(); let palma = connection(&old,"palma"); validate(&old,&palma).unwrap();
        let manar = connection(&palma,"manar"); validate(&palma,&manar).unwrap();
        assert_eq!(manar["branches"]["unassigned"],old["branches"]["unassigned"]);
        assert_eq!(manar["outbox"],old["outbox"]);
    }
    #[test]
    fn connection_cannot_edit_or_move_legacy_data_bind_queue_or_create_new_transactions() {
        let old = original(); let saved = connection(&old,"palma");
        for field in ["products","sales","entries","refunds","heldSales"] {
            let mut modified=saved.clone(); modified["branches"]["unassigned"][field]=json!([]);
            if modified != saved { assert!(validate(&old,&modified).is_err()); }
            let mut transaction=saved.clone(); transaction["branches"]["daily/palma"][field]=json!([{"id":"unsafe"}]);
            assert!(validate(&old,&transaction).is_err());
        }
        for field in ["outbox","pendingRequests","project1Settings","legacyStorageArchive"] {
            let mut modified=saved.clone(); modified[field]=json!({"changed":true}); assert!(validate(&old,&modified).is_err());
        }
    }
    #[test]
    fn existing_reconciliation_lock_survives_connection_switch_but_still_blocks_data_changes() {
        let mut old=connection(&original(),"palma");
        old["legacyBranchRecovery"]=json!({"businessId":"daily","branchId":"palma","reconciliationPending":true});
        let next=connection(&old,"manar"); validate(&old,&next).unwrap();
        let mut unsafe_state=next.clone(); unsafe_state["legacyBranchRecovery"]=Value::Null;
        assert!(validate(&old,&unsafe_state).is_err());
    }
    #[test]
    fn financial_history_alone_does_not_lock_scoped_inventory_but_old_queue_remains_frozen(){
        let mut old=connection(&original(),"palma");old["branches"]["unassigned"]["products"]=json!([]);
        old["branches"]["daily/palma"]["products"]=json!([{"id":"scoped","stockQuantity":10}]);
        old["outbox"][0]["businessId"]=json!("daily");old["outbox"][0]["branchId"]=json!("palma");
        let mut next=old.clone();next["branches"]["daily/palma"]["products"][0]["stockQuantity"]=json!(8);
        next["outbox"].as_array_mut().unwrap().push(json!({"operationId":"new-sale","businessId":"daily","branchId":"palma","protocolRevision":3}));
        validate(&old,&next).unwrap();
        let mut replay=next.clone();replay["outbox"].as_array_mut().unwrap().remove(0);assert!(validate(&next,&replay).is_err());
        let mut frozen=next.clone();frozen["branches"]["unassigned"]["sales"]=json!([]);assert!(validate(&next,&frozen).is_err());
    }
    #[test]
    fn sqlite_connection_save_readback_and_process_reopen_preserve_original_book() {
        tauri::async_runtime::block_on(async {
            let dir=std::env::temp_dir().join(format!("swift-till-connection-copy-{}",rand_core::OsRng.next_u64()));
            std::fs::create_dir(&dir).unwrap(); let path=dir.join("copy.db");
            let mut db=crate::initialization::connect(&path).await.unwrap();
            sqlx::query(include_str!("../migrations/003_durable_state.sql")).execute(&mut db).await.unwrap();
            let original=original(); assert!(crate::state_store::compare_and_swap(&mut db,-1,&original).await.unwrap());
            let saved=connection(&original,"palma"); validate(&original,&saved).unwrap();
            assert!(crate::state_store::compare_and_swap(&mut db,0,&saved).await.unwrap());
            assert_eq!(crate::state_store::read_state(&mut db).await.unwrap().unwrap(),saved);
            db.close().await.unwrap();
            let mut reopened=sqlx::SqliteConnection::connect_with(&sqlx::sqlite::SqliteConnectOptions::new().filename(&path).read_only(true)).await.unwrap();
            assert_eq!(crate::state_store::read_state(&mut reopened).await.unwrap().unwrap(),saved);
            assert_eq!(sqlx::query_scalar::<_,String>("PRAGMA integrity_check").fetch_one(&mut reopened).await.unwrap(),"ok");
        });
    }
}
