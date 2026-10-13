use crate::initialization::{authenticate, backup_before_upgrade, connect, create_admin, initialize, LegacyData};
use crate::state_store::{compare_and_swap, legacy_snapshot, read_state};
use serde_json::{json, Value};
use sqlx::Connection;
use std::path::PathBuf;

fn path() -> PathBuf {
    let path=std::env::temp_dir().join(format!("swift-till-rust-{}",rand_core::OsRng.next_u64()));
    std::fs::create_dir_all(&path).unwrap(); path.join("pos_v2.db")
}
use rand_core::RngCore;

#[test]
fn large_original_sqlite_history_keeps_ids_totals_and_missing_items_without_replay(){tauri::async_runtime::block_on(async {
    let location=path();let mut db=connect(&location).await.unwrap();
    let input:LegacyData=serde_json::from_value(json!({"sales":(0..22220).map(|i|json!({
        "id":format!("original-{i}"),"subtotal":2,"total":if i%2==0{2}else{179000},
        "currency":if i%2==0{"USD"}else{"LBP"},"exchangeRate":89500,
        "cashierName":"Original cashier","date":"2026-09-30T22:30:00Z","refunded":false,"items":[]
    })).collect::<Vec<_>>()})).unwrap();
    initialize(&mut db,&input).await.unwrap();
    let original=legacy_snapshot(&mut db).await.unwrap();assert_eq!(original["sales"].as_array().unwrap().len(),22220);
    let totals:Vec<(String,i64,f64)>=sqlx::query_as("SELECT currency,count(*),sum(total) FROM sales GROUP BY currency ORDER BY currency").fetch_all(&mut db).await.unwrap();
    assert_eq!(totals,vec![("LBP".into(),11110,1988690000.0),("USD".into(),11110,22220.0)]);
    assert_eq!(sqlx::query_scalar::<_,i64>("SELECT count(*) FROM sale_items").fetch_one(&mut db).await.unwrap(),0);
    for record in original["sales"].as_array().unwrap(){assert_eq!(record["legacy"],true);assert_eq!(record["items"],json!([]));}
    // Reopening and retrying the original import cannot duplicate rows or
    // reconstruct missing items. The SQLite marker is authoritative.
    db.close().await.unwrap();let mut reopened=connect(&location).await.unwrap();initialize(&mut reopened,&input).await.unwrap();
    let after=legacy_snapshot(&mut reopened).await.unwrap();assert_eq!(after,original);
    let ids:Vec<String>=sqlx::query_scalar("SELECT id FROM sales ORDER BY id").fetch_all(&mut reopened).await.unwrap();
    assert_eq!(ids.len(),22220);assert!(ids.contains(&"original-0".into())&&ids.contains(&"original-22219".into()));
    assert_eq!(sqlx::query_scalar::<_,String>("PRAGMA integrity_check").fetch_one(&mut reopened).await.unwrap(),"ok");
});}
fn legacy() -> LegacyData { serde_json::from_value(json!({"users":[{"id":"original-admin","username":"owner","password":"original-password","role":"admin","name":"Owner"}],"products":[{"id":"original-product","barcode":"123","name":"Coffee","stockQuantity":10,"purchasePrice":2,"salePrice":4}],"sales":[{"id":"old-sale","subtotal":8,"total":8,"currency":"USD","exchangeRate":89500,"cashierName":"Owner","date":"2025-01-01T12:00:00Z","refunded":false,"items":[]}],"exchangeRate":90000})).unwrap() }
fn doc(revision:i64, stock:i64) -> Value { json!({"version":2,"revision":revision,"branches":{"unassigned":{"products":[{"id":"p","stockQuantity":stock}],"sales":[],"completed":{}}},"outbox":[]}) }

#[test]
fn original_records_and_marker_survive_repeat_initialization() { tauri::async_runtime::block_on(async {
    let mut db=connect(&path()).await.unwrap();
    assert!(!initialize(&mut db,&legacy()).await.unwrap());
    let before=legacy_snapshot(&mut db).await.unwrap();
    assert!(!initialize(&mut db,&LegacyData::default()).await.unwrap());
    assert_eq!(before,legacy_snapshot(&mut db).await.unwrap());
    assert_eq!(before["sales"][0]["items"],json!([]));
    assert_eq!(before["products"][0]["stockQuantity"],10);
    assert_eq!(before["settings"]["exchange_rate"],"90000");
}); }

#[test]
fn conflicting_legacy_barcode_rolls_back_all_imported_rows() { tauri::async_runtime::block_on(async {
    let mut db=connect(&path()).await.unwrap();
    let input:LegacyData=serde_json::from_value(json!({"products":[{"id":"a","barcode":"same","name":"A","stockQuantity":1,"purchasePrice":1,"salePrice":2},{"id":"b","barcode":"same","name":"B","stockQuantity":1,"purchasePrice":1,"salePrice":2}]})).unwrap();
    assert!(initialize(&mut db,&input).await.is_err());
    initialize(&mut db,&LegacyData::default()).await.unwrap();
    let count:i64=sqlx::query_scalar("SELECT count(*) FROM products").fetch_one(&mut db).await.unwrap();
    assert_eq!(count,0);
}); }

#[test]
fn setup_closes_and_existing_credentials_upgrade_without_account_loss() { tauri::async_runtime::block_on(async {
    let mut db=connect(&path()).await.unwrap();
    assert!(initialize(&mut db,&LegacyData::default()).await.unwrap());
    assert!(create_admin(&mut db,"admin","short","Admin").await.is_err());
    create_admin(&mut db,"admin","long-test-password","Admin").await.unwrap();
    assert!(create_admin(&mut db,"rogue","long-test-password","Rogue").await.is_err());
    assert!(authenticate(&mut db,"admin","wrong").await.unwrap().is_none());
    let public=authenticate(&mut db,"admin","long-test-password").await.unwrap().unwrap();
    assert_eq!(public.role,"admin");
    assert!(!serde_json::to_string(&public).unwrap().contains("password"));
    let mut original=connect(&path()).await.unwrap();
    initialize(&mut original,&legacy()).await.unwrap();
    assert!(authenticate(&mut original,"owner","original-password").await.unwrap().is_some());
    let hash:String=sqlx::query_scalar("SELECT password FROM users WHERE id='original-admin'").fetch_one(&mut original).await.unwrap();
    assert!(hash.starts_with("$argon2"));
    assert!(authenticate(&mut original,"owner","original-password").await.unwrap().is_some());
}); }

#[test]
fn compare_and_swap_prevents_lost_stock_and_persists_queue_after_reopen() { tauri::async_runtime::block_on(async {
    let path=path(); let mut a=connect(&path).await.unwrap();
    initialize(&mut a,&LegacyData::default()).await.unwrap();
    assert!(compare_and_swap(&mut a,-1,&doc(0,10)).await.unwrap());
    let mut b=connect(&path).await.unwrap();
    let mut sale=doc(1,8); sale["outbox"]=json!([{"operationId":"sale:stable","type":"sale"}]);
    assert!(compare_and_swap(&mut a,0,&sale).await.unwrap());
    assert!(!compare_and_swap(&mut b,0,&doc(1,7)).await.unwrap());
    a.close().await.unwrap(); b.close().await.unwrap();
    let mut reopened=connect(&path).await.unwrap();
    assert_eq!(read_state(&mut reopened).await.unwrap().unwrap(),sale);
    assert!(compare_and_swap(&mut reopened,1,&doc(9,0)).await.is_err());
    assert_eq!(read_state(&mut reopened).await.unwrap().unwrap(),sale);
}); }

#[test]
fn competing_native_connections_allow_only_one_same_revision_commit() {
    let path=path();
    tauri::async_runtime::block_on(async {let mut db=connect(&path).await.unwrap(); initialize(&mut db,&LegacyData::default()).await.unwrap(); compare_and_swap(&mut db,-1,&doc(0,1)).await.unwrap();});
    let threads:Vec<_>=(0..6).map(|_| {let path=path.clone();std::thread::spawn(move || tauri::async_runtime::block_on(async {let mut db=connect(&path).await.unwrap();compare_and_swap(&mut db,0,&doc(1,0)).await.unwrap()}))}).collect();
    assert_eq!(threads.into_iter().filter_map(|t|t.join().ok()).filter(|won|*won).count(),1);
}

#[test]
fn consistent_backup_can_be_restored_and_original_tables_are_unchanged() { tauri::async_runtime::block_on(async {
    let original_path=path(); let mut original=connect(&original_path).await.unwrap();
    sqlx::query(include_str!("../migrations/001_create_pos_tables.sql")).execute(&mut original).await.unwrap();
    sqlx::query("INSERT INTO products VALUES('preserved','old-barcode','Original',-2,1.5,3,0)").execute(&mut original).await.unwrap();
    let backup=backup_before_upgrade(&mut original,&original_path).await.unwrap().unwrap();
    initialize(&mut original,&LegacyData::default()).await.unwrap();
    let after=legacy_snapshot(&mut original).await.unwrap();
    let restored=path();std::fs::copy(backup,&restored).unwrap();
    let mut copy=connect(&restored).await.unwrap();
    let stock:i64=sqlx::query_scalar("SELECT stockQuantity FROM products WHERE id='preserved'").fetch_one(&mut copy).await.unwrap();
    assert_eq!(stock,-2); assert_eq!(after["products"][0]["stockQuantity"],-2);
    assert!(backup_before_upgrade(&mut original,&original_path).await.unwrap().is_none());
}); }

#[test]
fn missing_synced_columns_upgrade_without_replacing_existing_rows() { tauri::async_runtime::block_on(async {
    let mut db=connect(&path()).await.unwrap();
    sqlx::query("CREATE TABLE products(id TEXT PRIMARY KEY,barcode TEXT NOT NULL UNIQUE,name TEXT NOT NULL,stockQuantity INTEGER NOT NULL,purchasePrice REAL NOT NULL,salePrice REAL NOT NULL); INSERT INTO products VALUES('old','123','Original',7,1,2)").execute(&mut db).await.unwrap();
    initialize(&mut db,&LegacyData::default()).await.unwrap();
    let result:(i64,i64)=sqlx::query_as("SELECT stockQuantity,synced FROM products WHERE id='old'").fetch_one(&mut db).await.unwrap();
    assert_eq!(result,(7,0));
}); }

#[test]
fn deleting_all_accounts_does_not_reopen_first_run_setup() { tauri::async_runtime::block_on(async {
    let mut db=connect(&path()).await.unwrap();initialize(&mut db,&LegacyData::default()).await.unwrap();
    create_admin(&mut db,"admin","long-test-password","Admin").await.unwrap();
    sqlx::query("DELETE FROM users").execute(&mut db).await.unwrap();
    assert!(initialize(&mut db,&LegacyData::default()).await.unwrap_err().contains("recovery"));
}); }

#[test]
fn legacy_financial_and_stock_writers_are_blocked_after_durable_cutover() { tauri::async_runtime::block_on(async {
    let mut db=connect(&path()).await.unwrap();initialize(&mut db,&legacy()).await.unwrap();
    let original=legacy_snapshot(&mut db).await.unwrap();
    assert!(compare_and_swap(&mut db,-1,&doc(0,10)).await.unwrap());
    for statement in ["UPDATE products SET stockQuantity=999", "INSERT INTO products VALUES('rogue','rogue','Rogue',999,1,2,0)", "DELETE FROM sales"] {
        assert!(sqlx::query(statement).execute(&mut db).await.unwrap_err().to_string().contains("Legacy clients cannot write"));
    }
    assert_eq!(original,legacy_snapshot(&mut db).await.unwrap());
    assert!(compare_and_swap(&mut db,0,&doc(1,8)).await.unwrap());
    assert_eq!(read_state(&mut db).await.unwrap().unwrap()["branches"]["unassigned"]["products"][0]["stockQuantity"],8);
    assert_eq!(original,legacy_snapshot(&mut db).await.unwrap());
}); }

#[test]
fn version_three_customer_state_gets_a_verified_backup_before_version_four_guards() { tauri::async_runtime::block_on(async {
    let original_path=path();let mut db=connect(&original_path).await.unwrap();
    sqlx::query(include_str!("../migrations/001_create_pos_tables.sql")).execute(&mut db).await.unwrap();
    sqlx::query(include_str!("../migrations/003_durable_state.sql")).execute(&mut db).await.unwrap();
    assert!(compare_and_swap(&mut db,-1,&doc(0,10)).await.unwrap());
    let backup=backup_before_upgrade(&mut db,&original_path).await.unwrap().unwrap();
    assert!(backup.file_name().unwrap().to_string_lossy().starts_with("pos-before-v4-"));
    let mut copy=connect(&backup).await.unwrap();assert_eq!(read_state(&mut copy).await.unwrap(),Some(doc(0,10)));
    let guard_count:i64=sqlx::query_scalar("SELECT count(*) FROM sqlite_master WHERE type='trigger'").fetch_one(&mut copy).await.unwrap();assert_eq!(guard_count,0);
    initialize(&mut db,&LegacyData::default()).await.unwrap();
    assert!(backup_before_upgrade(&mut db,&original_path).await.unwrap().is_none());
    let guard_count:i64=sqlx::query_scalar("SELECT count(*) FROM sqlite_master WHERE type='trigger' AND name LIKE 'swift_till_v4_%'").fetch_one(&mut db).await.unwrap();assert_eq!(guard_count,18);
    assert_eq!(read_state(&mut db).await.unwrap(),Some(doc(0,10)));
}); }

// Explicit opt-in: reads only verified temporary backup files and performs all
// initialization on newly created copies. No customer credentials are printed.
#[test]
#[ignore = "requires a verified customer backup directory under OS temp"]
fn verified_customer_copies_survive_native_upgrade_and_restart() { tauri::async_runtime::block_on(async {
    let directory=PathBuf::from(std::env::var("SWIFT_TILL_CUSTOMER_COPY").expect("Provide verified temporary snapshot directory")).canonicalize().unwrap();
    let temp=std::env::temp_dir().canonicalize().unwrap();
    assert!(directory.parent()==Some(temp.as_path()) && directory.file_name().unwrap().to_string_lossy().starts_with("swift-till-recovery-") && directory.join("manifest.json").is_file());
    let mut inputs=vec![directory.join("pos_v2.db"),directory.join("recovery-preview.db")];
    inputs.extend(std::fs::read_dir(&directory).unwrap().map(|entry|entry.unwrap().path()).filter(|p|p.file_name().unwrap().to_string_lossy().starts_with("pos-before-v3-") && p.extension().is_some_and(|e|e=="db")));
    assert_eq!(inputs.len(),3);
    for input in inputs {
        let copied=path(); std::fs::copy(&input,&copied).unwrap();
        let mut db=connect(&copied).await.unwrap();
        let tables=["users","products","inventory_entries","sales","sale_items","refunds","refund_items","settings"];
        let mut preserved=Vec::new();
        for table in tables {
            let columns:Vec<String>=sqlx::query("SELECT name FROM pragma_table_info(?) ORDER BY cid").bind(table).fetch_all(&mut db).await.unwrap().into_iter().map(|row| {use sqlx::Row; row.get("name")}).collect();
            let select=format!("SELECT json_array({}) FROM {table} ORDER BY 1",columns.iter().map(|c|format!("\"{c}\"")).collect::<Vec<_>>().join(","));
            let rows:Vec<String>=sqlx::query_scalar(&select).fetch_all(&mut db).await.unwrap();
            preserved.push((table,select,rows));
        }
        let has_state:i64=sqlx::query_scalar("SELECT count(*) FROM sqlite_master WHERE name='pos_state'").fetch_one(&mut db).await.unwrap();
        let state=if has_state>0 {read_state(&mut db).await.unwrap()}else{None};
        backup_before_upgrade(&mut db,&copied).await.unwrap();
        let legacy:LegacyData=serde_json::from_value(json!({"alreadyMigrated":true})).unwrap();
        initialize(&mut db,&legacy).await.unwrap();
        db.close().await.unwrap();
        let mut reopened=connect(&copied).await.unwrap();
        initialize(&mut reopened,&legacy).await.unwrap();
        for (table,select,rows) in preserved {
            let after:Vec<String>=sqlx::query_scalar(&select).fetch_all(&mut reopened).await.unwrap();
            if table=="settings" {assert!(rows.iter().all(|row|after.contains(row)),"Original settings lost");} else {assert_eq!(rows,after,"Original {table} changed");}
        }
        assert_eq!(state,read_state(&mut reopened).await.unwrap());
        let integrity:String=sqlx::query_scalar("PRAGMA integrity_check").fetch_one(&mut reopened).await.unwrap();assert_eq!(integrity,"ok");
        println!("Verified copy upgraded twice and reopened without record, account, setting or queue loss: {}",input.file_name().unwrap().to_string_lossy());
    }
}); }
