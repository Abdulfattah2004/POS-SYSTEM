// Only the validated disposable QA process uses these diagnostics. Inspection
// is read-only: it must never create a database or initialize missing tables.
use serde_json::{json, Value};
use sqlx::{Connection, SqliteConnection, sqlite::SqliteConnectOptions};
use std::path::Path;

fn failure(stage: &str, error: sqlx::Error) -> Value {
    let cause = error.as_database_error();
    json!({"error":"Disposable frontend did not provide readable initialized SQLite state",
        "stage":stage,"sqliteCode":cause.and_then(|e|e.code()).map(|s|s.into_owned()),
        // Only fixed diagnostic SELECT/PRAGMA statements run here, without
        // customer parameters; errors reveal no credentials or record values.
        "sqliteCause":cause.map(|e|e.message()),"errorKind":if cause.is_some(){"database"}else{"connection"}})
}

pub(crate) async fn inspect(profile: &Path) -> Value {
    let file=profile.join("pos_v2.db");
    if !file.is_file() {return json!({"error":"Frontend SQLite initialization was not observed","stage":"database_missing"});}
    let mut db=match SqliteConnection::connect_with(&SqliteConnectOptions::new().filename(&file).read_only(true).create_if_missing(false)).await {
        Ok(db)=>db,Err(error)=>return failure("open_read_only",error)
    };
    let raw:Option<String>=match sqlx::query_scalar("SELECT document FROM pos_state WHERE id=1").fetch_optional(&mut db).await {
        Ok(raw)=>raw,Err(error)=>return failure("read_pos_state",error)
    };
    let state:Option<Value>=match raw.map(|raw|serde_json::from_str(&raw)).transpose() {
        Ok(state)=>state,Err(_)=>return json!({"error":"Disposable local state JSON is invalid","stage":"parse_pos_state"})
    };
    let integrity:String=match sqlx::query_scalar("PRAGMA integrity_check").fetch_one(&mut db).await {
        Ok(integrity)=>integrity,Err(error)=>return failure("integrity",error)
    };
    json!({"integrity":integrity,"initialized":state.is_some(),"version":state.as_ref().map(|s|s["version"].clone()),"webview_isolated":profile.join("webview").is_dir()})
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand_core::RngCore;
    fn profile()->std::path::PathBuf {
        let path=std::env::temp_dir().join(format!("swift-till-qa-inspection-{}",rand_core::OsRng.next_u64()));
        std::fs::create_dir(&path).unwrap();path
    }
    #[test]
    fn missing_database_is_not_created_by_the_smoke_watchdog() {tauri::async_runtime::block_on(async {
        let path=profile();let report=inspect(&path).await;
        assert_eq!(report["stage"],"database_missing");assert!(!path.join("pos_v2.db").exists());
    });}
    #[test]
    fn missing_schema_retains_the_actual_sqlite_cause_without_repair() {tauri::async_runtime::block_on(async {
        let path=profile();std::fs::write(path.join("pos_v2.db"),[]).unwrap();
        let report=inspect(&path).await;
        assert_eq!(report["stage"],"read_pos_state");
        assert_eq!(report["sqliteCode"],"1");assert!(report["sqliteCause"].as_str().unwrap().contains("no such table: pos_state"));
        assert_eq!(std::fs::metadata(path.join("pos_v2.db")).unwrap().len(),0);
    });}
    #[test]
    fn initialized_database_is_inspected_without_modifying_it() {tauri::async_runtime::block_on(async {
        let path=profile();std::fs::create_dir(path.join("webview")).unwrap();
        let mut db=crate::initialization::connect(&path.join("pos_v2.db")).await.unwrap();
        sqlx::query("CREATE TABLE pos_state(id INTEGER PRIMARY KEY,document TEXT); INSERT INTO pos_state VALUES(1,'{\"version\":2}')").execute(&mut db).await.unwrap();
        db.close().await.unwrap();let original=std::fs::read(path.join("pos_v2.db")).unwrap();
        let report=inspect(&path).await;assert_eq!(report,json!({"integrity":"ok","initialized":true,"version":2,"webview_isolated":true}));
        assert_eq!(std::fs::read(path.join("pos_v2.db")).unwrap(),original);
    });}
}
