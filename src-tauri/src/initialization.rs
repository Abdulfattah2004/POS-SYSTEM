use argon2::{password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString}, Argon2};
use rand_core::OsRng;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::{Connection, Row, SqliteConnection, sqlite::SqliteConnectOptions};
use std::{path::Path, time::Duration};
use tauri::Manager;

const DATABASE_FILE: &str = "pos_v2.db";
const IMPORT_MARKER: &str = "legacy_import_v1";
const SETUP_MARKER: &str = "first_admin_created";
const SYNC_TABLES: [&str; 6] = ["products", "sales", "sale_items", "refunds", "refund_items", "inventory_entries"];

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LegacyData {
    #[serde(default)] users: Vec<Value>,
    #[serde(default)] products: Vec<Value>,
    #[serde(default)] sales: Vec<Value>,
    #[serde(default)] refunds: Vec<Value>,
    #[serde(default)] inventory_entries: Vec<Value>,
    exchange_rate: Option<f64>,
    #[serde(default)] already_migrated: bool,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PublicUser { pub id: String, pub username: String, pub role: String, pub name: String, pub requires_password_change: bool }

pub(crate) async fn connect(path: &Path) -> Result<SqliteConnection, String> {
    SqliteConnection::connect_with(&SqliteConnectOptions::new().filename(path)
        .create_if_missing(true).busy_timeout(Duration::from_secs(15)))
        .await.map_err(|_| "Unable to open the local database".into())
}

pub(crate) fn qa_profile() -> Result<Option<std::path::PathBuf>, String> {
    // QA may select only a marked disposable profile under the OS temp folder.
    if let Ok(profile) = std::env::var("SWIFT_TILL_QA_PROFILE") {
        let path = std::path::PathBuf::from(profile).canonicalize().map_err(|_| "Invalid QA profile")?;
        let temp = std::env::temp_dir().canonicalize().map_err(|_| "Invalid temporary directory")?;
        if !path.starts_with(temp) || !path.join(".swift-till-synthetic-profile").is_file() {
            return Err("QA profile must be a marked disposable temporary directory".into());
        }
        return Ok(Some(path));
    }
    Ok(None)
}

pub(crate) fn app_database(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    if let Some(path)=development_profile()? { return Ok(path.join(DATABASE_FILE)); }
    if let Some(path)=qa_profile()? { return Ok(path.join(DATABASE_FILE)); }
    let directory = app.path().app_config_dir().map_err(|_| "Unable to resolve application data directory")?;
    // Never silently initialize a different file when the original URL's file exists.
    if !directory.join(DATABASE_FILE).exists() && directory.join("pos_v2").exists() {
        return Err("An older database named pos_v2 exists. Preserve it and review the database location before initialization.".into());
    }
    std::fs::create_dir_all(&directory).map_err(|_| "Unable to access application data directory")?;
    Ok(directory.join(DATABASE_FILE))
}

pub(crate) fn development_profile() -> Result<Option<std::path::PathBuf>, String> {
    let Some(value)=std::env::var_os("SWIFT_TILL_DEV_PROFILE") else {return Ok(None)};
    if std::env::var_os("SWIFT_TILL_QA_PROFILE").is_some() {return Err("Choose one disposable profile mode".into());}
    #[cfg(debug_assertions)]
    { crate::development_profile::validate_profile(std::path::Path::new(&value)).map(Some) }
    #[cfg(not(debug_assertions))]
    { let _=value; Err("Disposable development profiles require a debug build; no customer profile was opened".into()) }
}

fn text<'a>(row: &'a Value, key: &str) -> Result<&'a str, String> {
    row.get(key).and_then(Value::as_str).ok_or_else(|| format!("Legacy record has an invalid {key}; import stopped without changing records"))
}
fn optional_text<'a>(row: &'a Value, key: &str) -> &'a str {
    row.get(key).and_then(Value::as_str).unwrap_or("")
}
fn number(row: &Value, key: &str) -> Result<f64, String> {
    let value = row.get(key).and_then(|v| v.as_f64().or_else(|| v.as_str()?.parse().ok()));
    value.filter(|v| v.is_finite()).ok_or_else(|| format!("Legacy record has an invalid {key}; import stopped without changing records"))
}
fn items(row: &Value) -> Result<&[Value], String> {
    match row.get("items") {
        None => Ok(&[]),
        Some(Value::Array(items)) => Ok(items),
        _ => Err("Legacy transaction items are invalid; import stopped".into()),
    }
}
pub(crate) fn hash_password(password: &str) -> Result<String, String> {
    Argon2::default().hash_password(password.as_bytes(), &SaltString::generate(&mut OsRng))
        .map(|hash| hash.to_string()).map_err(|_| "Unable to secure password".into())
}

async fn marker(conn: &mut SqliteConnection, key: &str) -> Result<bool, sqlx::Error> {
    Ok(sqlx::query_scalar::<_, String>("SELECT value FROM settings WHERE key = ?").bind(key)
        .fetch_optional(conn).await?.as_deref() == Some("true"))
}

pub(crate) async fn initialize(conn: &mut SqliteConnection, legacy: &LegacyData) -> Result<bool, String> {
    let mut tx = conn.begin_with("BEGIN IMMEDIATE").await.map_err(|_| "Database is busy; retry initialization")?;
    // Existing schema scripts remain unchanged so recorded migration checksums stay valid.
    sqlx::query(include_str!("../migrations/001_create_pos_tables.sql"))
        .execute(&mut *tx).await.map_err(|_| "Unable to initialize database schema")?;
    for table in SYNC_TABLES {
        let columns = sqlx::query(&format!("PRAGMA table_info({table})")).fetch_all(&mut *tx).await.map_err(|_| "Unable to inspect database schema")?;
        if !columns.iter().any(|row| row.get::<String, _>("name") == "synced") {
            sqlx::query(&format!("ALTER TABLE {table} ADD COLUMN synced INTEGER NOT NULL DEFAULT 0"))
                .execute(&mut *tx).await.map_err(|_| "Unable to upgrade sync columns")?;
        }
    }
    sqlx::query(include_str!("../migrations/002_add_indexes.sql"))
        .execute(&mut *tx).await.map_err(|_| "Unable to initialize database indexes")?;
    sqlx::query(include_str!("../migrations/003_durable_state.sql"))
        .execute(&mut *tx).await.map_err(|_| "Unable to initialize durable transaction storage")?;
    if !marker(&mut tx, IMPORT_MARKER).await.map_err(|_| "Unable to inspect import status")? {
        if !legacy.already_migrated {
            import_legacy(&mut tx, legacy).await?;
        }
        sqlx::query("INSERT INTO settings (key,value) VALUES (?, 'true') ON CONFLICT(key) DO NOTHING")
            .bind(IMPORT_MARKER).execute(&mut *tx).await.map_err(|_| "Unable to record import completion")?;
    }
    sqlx::query("INSERT INTO settings (key,value) VALUES ('exchange_rate','89500') ON CONFLICT(key) DO NOTHING")
        .execute(&mut *tx).await.map_err(|_| "Unable to initialize settings")?;
    sqlx::query(include_str!("../migrations/004_guard_legacy_writers.sql"))
        .execute(&mut *tx).await.map_err(|_| "Unable to protect historical tables from incompatible client writes")?;
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users").fetch_one(&mut *tx).await.map_err(|_| "Unable to inspect local accounts")?;
    let setup_closed = marker(&mut tx, SETUP_MARKER).await.map_err(|_| "Unable to inspect administrator setup")?;
    if count == 0 && setup_closed {
        return Err("No local accounts remain. Administrator recovery is required; first-run setup cannot be reopened.".into());
    }
    if count > 0 {
        sqlx::query("INSERT INTO settings(key,value) VALUES(?,'true') ON CONFLICT(key) DO UPDATE SET value='true'")
            .bind(SETUP_MARKER).execute(&mut *tx).await.map_err(|_| "Cannot close existing administrator setup")?;
    }
    tx.commit().await.map_err(|_| "Unable to commit database initialization")?;
    Ok(count == 0)
}

async fn import_legacy(conn: &mut SqliteConnection, data: &LegacyData) -> Result<(), String> {
    // Plain INSERT plus a targeted ID conflict handler never replaces existing records.
    // Other unique conflicts abort the entire import rather than silently discarding data.
    for row in &data.users {
        sqlx::query("INSERT INTO users(id,username,password,role,name) VALUES(?,?,?,?,?) ON CONFLICT(id) DO NOTHING")
            .bind(text(row,"id")?).bind(text(row,"username")?).bind(text(row,"password")?)
            .bind(text(row,"role")?).bind(text(row,"name")?).execute(&mut *conn).await.map_err(|_| "Legacy user conflict; import rolled back")?;
    }
    for row in &data.products {
        sqlx::query("INSERT INTO products(id,barcode,name,stockQuantity,purchasePrice,salePrice) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING")
            .bind(text(row,"id")?).bind(text(row,"barcode")?).bind(text(row,"name")?)
            .bind(number(row,"stockQuantity")?).bind(number(row,"purchasePrice")?).bind(number(row,"salePrice")?)
            .execute(&mut *conn).await.map_err(|_| "Legacy product conflict; import rolled back")?;
    }
    for row in &data.sales {
        let id = text(row,"id")?;
        let inserted = sqlx::query("INSERT INTO sales(id,subtotal,total,currency,exchangeRate,cashierName,date,refunded) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING")
            .bind(id).bind(number(row,"subtotal")?).bind(number(row,"total")?).bind(text(row,"currency")?)
            .bind(number(row,"exchangeRate")?).bind(optional_text(row,"cashierName")).bind(text(row,"date")?)
            .bind(row.get("refunded").and_then(Value::as_bool).unwrap_or(false))
            .execute(&mut *conn).await.map_err(|_| "Legacy sale conflict; import rolled back")?.rows_affected();
        if inserted == 1 { import_items(conn,"sale_items","saleId",id,items(row)?,text(row,"currency")?).await?; }
    }
    for row in &data.refunds {
        let id = text(row,"id")?;
        let inserted = sqlx::query("INSERT INTO refunds(id,saleId,totalRefunded,currency,date,cashierName) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING")
            .bind(id).bind(text(row,"saleId")?).bind(number(row,"totalRefunded")?).bind(text(row,"currency")?)
            .bind(text(row,"date")?).bind(optional_text(row,"cashierName"))
            .execute(&mut *conn).await.map_err(|_| "Legacy refund conflict; import rolled back")?.rows_affected();
        if inserted == 1 { import_items(conn,"refund_items","refundId",id,items(row)?,text(row,"currency")?).await?; }
    }
    for row in &data.inventory_entries {
        sqlx::query("INSERT INTO inventory_entries(id,productId,productName,barcode,quantityAdded,purchasePrice,salePrice,salesmanName,date) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING")
            .bind(text(row,"id")?).bind(optional_text(row,"productId")).bind(text(row,"productName")?)
            .bind(text(row,"barcode")?).bind(number(row,"quantityAdded")?).bind(number(row,"purchasePrice")?)
            .bind(number(row,"salePrice")?).bind(optional_text(row,"salesmanName")).bind(text(row,"date")?)
            .execute(&mut *conn).await.map_err(|_| "Legacy inventory conflict; import rolled back")?;
    }
    if let Some(rate) = data.exchange_rate {
        if !rate.is_finite() || rate <= 0.0 { return Err("Invalid legacy exchange rate; import rolled back".into()); }
        sqlx::query("INSERT INTO settings(key,value) VALUES('exchange_rate',?) ON CONFLICT(key) DO NOTHING")
            .bind(rate.to_string()).execute(&mut *conn).await.map_err(|_| "Unable to import exchange rate")?;
    }
    Ok(())
}

async fn import_items(conn: &mut SqliteConnection, table: &str, parent_column: &str, parent: &str, rows: &[Value], currency: &str) -> Result<(), String> {
    for (index,row) in rows.iter().enumerate() {
        let id = format!("legacy:{table}:{}:{parent}:{index}", parent.len());
        sqlx::query(&format!("INSERT INTO {table}(id,{parent_column},productId,productName,barcode,quantity,salePrice,purchasePrice,currency) VALUES(?,?,?,?,?,?,?,?,?)"))
            .bind(id).bind(parent).bind(text(row,"productId")?).bind(text(row,"productName")?).bind(text(row,"barcode")?)
            .bind(number(row,"quantity")?).bind(number(row,"salePrice")?).bind(number(row,"purchasePrice")?)
            .bind(row.get("currency").and_then(Value::as_str).unwrap_or(currency))
            .execute(&mut *conn).await.map_err(|_| "Legacy item conflict; import rolled back")?;
    }
    Ok(())
}

#[tauri::command]
pub async fn initialize_database(app: tauri::AppHandle, legacy: LegacyData) -> Result<bool, String> {
    let path=app_database(&app)?;
    if legacy.already_migrated && !path.exists() { return Err("Previously migrated database is missing. Restore the original database before continuing; no empty replacement was created.".into()); }
    let mut conn = connect(&path).await?;
    backup_before_upgrade(&mut conn, &path).await?;
    initialize(&mut conn, &legacy).await
}

pub(crate) async fn backup_before_upgrade(conn:&mut SqliteConnection,path:&Path) -> Result<Option<std::path::PathBuf>,String> {
    let has_events:i64=sqlx::query_scalar("SELECT count(*) FROM sqlite_master WHERE type='table' AND name='pos_upgrade_events'").fetch_one(&mut *conn).await.map_err(|_| "Cannot inspect upgrade status")?;
    let has_users:i64=sqlx::query_scalar("SELECT count(*) FROM sqlite_master WHERE type='table' AND name='users'").fetch_one(&mut *conn).await.map_err(|_| "Cannot inspect original schema")?;
    if has_users==0 { return Ok(None); }
    if has_events>0 {
        let guarded:i64=sqlx::query_scalar("SELECT count(*) FROM pos_upgrade_events WHERE version=4").fetch_one(&mut *conn).await.map_err(|_| "Cannot inspect historical-write guard upgrade")?;
        if guarded>0 {return Ok(None);}
    }
    let folder=path.parent().ok_or("Invalid database location")?.join("upgrade-backups");
    std::fs::create_dir_all(&folder).map_err(|_| "Cannot create upgrade backup folder; upgrade stopped")?;
    let backup=folder.join(format!("pos-before-v4-{}.db",SaltString::generate(&mut OsRng).as_str().replace('/',"_")));
    // VACUUM INTO produces a consistent SQLite backup, including committed WAL.
    // It refuses to overwrite a nonempty existing file.
    sqlx::query("VACUUM INTO ?").bind(backup.to_string_lossy().as_ref()).execute(&mut *conn).await.map_err(|_| "Cannot create consistent upgrade backup; upgrade stopped")?;
    let mut copy=connect(&backup).await?;
    let integrity:String=sqlx::query_scalar("PRAGMA integrity_check").fetch_one(&mut copy).await.map_err(|_| "Cannot verify upgrade backup")?;
    if integrity!="ok" {return Err("Upgrade backup integrity verification failed".into());}
    Ok(Some(backup))
}

pub(crate) async fn create_admin(conn: &mut SqliteConnection, username: &str, password: &str, name: &str) -> Result<(), String> {
    let username = username.trim(); let name = name.trim();
    if username.is_empty() || username.len() > 100 || name.is_empty() || name.len() > 200 || password.chars().count() < 12 || password.len() > 1024 {
        return Err("Enter a name, username, and password of at least 12 characters".into());
    }
    let hash = hash_password(password)?;
    let mut tx = conn.begin_with("BEGIN IMMEDIATE").await.map_err(|_| "Database is busy; retry setup")?;
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users").fetch_one(&mut *tx).await.map_err(|_| "Unable to inspect accounts")?;
    if count != 0 || marker(&mut tx, SETUP_MARKER).await.map_err(|_| "Unable to inspect setup status")? {
        return Err("First-run administrator setup is already closed".into());
    }
    let id = format!("admin:{}", SaltString::generate(&mut OsRng));
    sqlx::query("INSERT INTO users(id,username,password,role,name) VALUES(?,?,?,'admin',?)")
        .bind(id).bind(username).bind(hash).bind(name).execute(&mut *tx).await.map_err(|_| "Unable to create administrator")?;
    sqlx::query("INSERT INTO settings(key,value) VALUES(?,'true')")
        .bind(SETUP_MARKER).execute(&mut *tx).await.map_err(|_| "Unable to close first-run setup")?;
    tx.commit().await.map_err(|_| "Unable to commit administrator setup".to_string())
}

#[tauri::command]
pub async fn create_first_admin(app: tauri::AppHandle, username: String, password: String, name: String) -> Result<(), String> {
    let mut conn = connect(&app_database(&app)?).await?;
    create_admin(&mut conn, &username, &password, &name).await
}

pub(crate) async fn authenticate(conn: &mut SqliteConnection, username: &str, password: &str) -> Result<Option<PublicUser>, String> {
    let rows = sqlx::query("SELECT id,username,password,role,name FROM users WHERE lower(username)=lower(?)")
        .bind(username.trim()).fetch_all(&mut *conn).await.map_err(|_| "Unable to authenticate local account")?;
    if rows.len()>1 {return Err("Ambiguous local usernames require administrator review; no account was selected".into());}
    let Some(row) = rows.first() else { return Ok(None); };
    let stored: String = row.get("password");
    let valid = if stored.starts_with("$argon2") {
        PasswordHash::new(&stored).ok().is_some_and(|hash| Argon2::default().verify_password(password.as_bytes(), &hash).is_ok())
    } else {
        // Existing accounts remain usable; upgrade verified credentials in place.
        stored == password
    };
    if valid && !stored.starts_with("$argon2") {
        sqlx::query("UPDATE users SET password=? WHERE id=? AND password=?")
            .bind(hash_password(password)?).bind(row.get::<String,_>("id")).bind(&stored)
            .execute(&mut *conn).await.map_err(|_| "Unable to secure existing credential")?;
    }
    let rotation_key=format!("password_rotation:{}",row.get::<String,_>("id"));
    // Known fixture credentials are usable only in debug builds against a
    // marked direct-child OS-temp database seeded by the standalone dev tool.
    // This branch and the fixture tool do not exist in a release installer.
    #[cfg(debug_assertions)]
    let disposable_fixture=crate::development_profile::is_seeded_account(conn,&row.get::<String,_>("id")).await?;
    #[cfg(not(debug_assertions))]
    let disposable_fixture=false;
    if valid && !disposable_fixture && (password.chars().count()<12 || ["admin123","cashier123"].contains(&password)) {
        sqlx::query("INSERT INTO settings(key,value) VALUES(?,'true') ON CONFLICT(key) DO UPDATE SET value='true'").bind(&rotation_key).execute(&mut *conn).await.map_err(|_| "Cannot record password rotation")?;
    }
    let requires_password_change=marker(conn,&rotation_key).await.map_err(|_| "Cannot check password rotation")?;
    Ok(valid.then(|| PublicUser { id: row.get("id"), username: row.get("username"), role: row.get("role"), name: row.get("name"), requires_password_change }))
}

#[tauri::command]
pub async fn login_local(app: tauri::AppHandle, session: tauri::State<'_,crate::state_store::NativeSession>, username: String, password: String) -> Result<Option<PublicUser>, String> {
    let mut conn = connect(&app_database(&app)?).await?;
    *session.0.lock().map_err(|_| "Local session unavailable")? = None;
    let user = authenticate(&mut conn, &username, &password).await?;
    *session.0.lock().map_err(|_| "Local session unavailable")? = user.as_ref().map(|u|u.id.clone());
    Ok(user)
}
