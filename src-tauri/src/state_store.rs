use serde_json::{json, Value};
use sqlx::{Connection, Row, SqliteConnection};
use std::sync::Mutex;
use crate::initialization::{app_database, connect, hash_password, PublicUser};

#[derive(Default)]
pub struct NativeSession(pub Mutex<Option<String>>);

pub(crate) async fn read_state(conn: &mut SqliteConnection) -> Result<Option<Value>, String> {
    let raw: Option<String> = sqlx::query_scalar("SELECT document FROM pos_state WHERE id=1")
        .fetch_optional(conn).await.map_err(|_| "Cannot read durable local state")?;
    raw.map(|raw| serde_json::from_str(&raw).map_err(|_| "Local state is damaged; restore requires review".into())).transpose()
}

pub(crate) fn validate_pending_requests(old:&Value,next:&Value,actor:&str)->Result<(),String>{
    let scope=match (old["association"]["businessId"].as_str(),old["association"]["branchId"].as_str()) {
        (Some(business),Some(branch))=>format!("{business}/{branch}"),_=>"unassigned".into()
    };
    let suffix=format!(":{actor}:{scope}");
    let empty=serde_json::Map::new();
    let before=old["pendingRequests"].as_object().unwrap_or(&empty);
    let after=next["pendingRequests"].as_object().ok_or("Saved request map is invalid")?;
    for (key,value) in before {
        if !after.contains_key(key) {return Err("Saved request evidence cannot be removed; completion requires a tombstone".into());}
        if value==&after[key] {continue;}
        if !value.is_null() && !after[key].is_null() {return Err("Retry the original saved transaction; its ID and payload cannot change".into());}
    }
    for (key,value) in after {
        if before.get(key)==Some(value) {continue;}
        if !(key.starts_with("pos_checkout_v3:") || key.starts_with("pos_pending_v3:")) || !key.ends_with(&suffix) {
            return Err("Saved requests must belong to the signed-in operator and current branch".into());
        }
        if !value.is_null() && (value["id"].as_str().map_or(true,str::is_empty) || value.get("payload").is_none()) {
            return Err("Saved transaction is damaged".into());
        }
    }
    Ok(())
}

pub(crate) async fn compare_and_swap(conn: &mut SqliteConnection, expected: i64, state: &Value) -> Result<bool, String> {
    if state["version"] != 2 || state["revision"].as_i64() != Some(expected + 1)
        || !state["branches"].is_object() || !state["outbox"].is_array() {
        return Err("Invalid local state version or revision".into());
    }
    let mut tx = conn.begin_with("BEGIN IMMEDIATE").await.map_err(|_| "Local database busy; retry safely")?;
    let affected = if expected == -1 {
        sqlx::query("INSERT INTO pos_state(id,revision,document) VALUES(1,0,?) ON CONFLICT(id) DO NOTHING")
            .bind(state.to_string()).execute(&mut *tx).await
    } else {
        sqlx::query("UPDATE pos_state SET revision=?,document=? WHERE id=1 AND revision=?")
            .bind(expected+1).bind(state.to_string()).bind(expected).execute(&mut *tx).await
    }.map_err(|_| "Local transaction failed; no partial changes saved")?.rows_affected();
    tx.commit().await.map_err(|_| "Local commit could not be confirmed; retry the same operation")?;
    Ok(affected == 1)
}

async fn json_rows(conn: &mut SqliteConnection, query: &str) -> Result<Vec<Value>, String> {
    let rows: Vec<String> = sqlx::query_scalar(query).fetch_all(conn).await.map_err(|_| "Unable to read original SQLite records")?;
    rows.into_iter().map(|row| serde_json::from_str(&row).map_err(|_| "Invalid original SQLite record".into())).collect()
}

pub(crate) async fn legacy_snapshot(conn: &mut SqliteConnection) -> Result<Value,String> {
    let mut tx = conn.begin().await.map_err(|_| "Cannot open consistent upgrade snapshot")?;
    let products = json_rows(&mut tx, "SELECT json_object('id',id,'name',name,'barcode',barcode,'stockQuantity',stockQuantity,'purchasePrice',purchasePrice,'salePrice',salePrice) FROM products").await?;
    let sales = json_rows(&mut tx, "SELECT json_object('id',s.id,'subtotal',subtotal,'total',total,'currency',currency,'exchangeRate',exchangeRate,'cashierName',cashierName,'date',date,'refunded',json(CASE WHEN refunded=0 THEN 'false' ELSE 'true' END),'legacy',json('true'),'items',json(COALESCE((SELECT json_group_array(json_object('productId',productId,'productName',productName,'barcode',barcode,'quantity',quantity,'salePrice',salePrice,'purchasePrice',purchasePrice,'currency',currency)) FROM sale_items WHERE saleId=s.id),'[]'))) FROM sales s").await?;
    let refunds = json_rows(&mut tx, "SELECT json_object('id',r.id,'saleId',saleId,'totalRefunded',totalRefunded,'currency',currency,'date',date,'cashierName',cashierName,'legacy',json('true'),'items',json(COALESCE((SELECT json_group_array(json_object('productId',productId,'productName',productName,'barcode',barcode,'quantity',quantity,'salePrice',salePrice,'purchasePrice',purchasePrice,'currency',currency)) FROM refund_items WHERE refundId=r.id),'[]'))) FROM refunds r").await?;
    let entries = json_rows(&mut tx, "SELECT json_object('id',id,'productId',productId,'productName',productName,'barcode',barcode,'quantityAdded',quantityAdded,'purchasePrice',purchasePrice,'salePrice',salePrice,'salesmanName',salesmanName,'date',date,'legacy',json('true')) FROM inventory_entries").await?;
    let settings = sqlx::query("SELECT key,value FROM settings").fetch_all(&mut *tx).await.map_err(|_| "Cannot read original configuration")?;
    let mut config = serde_json::Map::new();
    for row in settings { config.insert(row.get("key"), Value::String(row.get("value"))); }
    tx.commit().await.map_err(|_| "Cannot close upgrade snapshot")?;
    Ok(json!({"products":products,"sales":sales,"refunds":refunds,"entries":entries,"settings":config}))
}

#[tauri::command]
pub async fn read_pos_state(app: tauri::AppHandle) -> Result<Option<Value>,String> {
    read_state(&mut connect(&app_database(&app)?).await?).await
}
#[tauri::command]
pub async fn read_original_snapshot(app: tauri::AppHandle) -> Result<Value,String> {
    legacy_snapshot(&mut connect(&app_database(&app)?).await?).await
}
#[tauri::command]
pub async fn commit_pos_state(app: tauri::AppHandle, session:tauri::State<'_,NativeSession>, expected_revision: i64, document: Value) -> Result<bool,String> {
    let mut conn=connect(&app_database(&app)?).await?;
    if let Some(old)=read_state(&mut conn).await? {
        if old["inventoryActivation"] != document["inventoryActivation"] {
            return Err("Inventory ownership proof can only be created through verified backup review".into());
        }
        crate::connection_safety::validate(&old, &document)?;
        if old["association"]!=document["association"] && old["pendingRequests"].as_object().is_some_and(|requests| requests.values().any(|request| !request.is_null())) {
            return Err("Confirm saved local transactions before switching branches".into());
        }
        if old["legacyBranchRecovery"] != document["legacyBranchRecovery"] &&
            !(old["legacyBranchRecovery"].is_null() && document["legacyBranchRecovery"]["reconciliationPending"]==true) {
            return Err("Reviewed branch reconciliation lock cannot be changed through ordinary operations".into());
        }
        if old["branches"]!=document["branches"] || old["outbox"]!=document["outbox"] || old["association"]!=document["association"] || old["legacyBranchRecovery"]!=document["legacyBranchRecovery"] || old["pendingRequests"]!=document["pendingRequests"] {
            let actor=session.0.lock().map_err(|_| "Local session unavailable")?.clone().ok_or("Sign in before changing local business records")?;
            let exists:i64=sqlx::query_scalar("SELECT count(*) FROM users WHERE id=?").bind(&actor).fetch_one(&mut conn).await.map_err(|_| "Cannot verify local session")?;
            if exists==0 {return Err("Local account no longer exists; sign in again".into());}
            require_password_rotation_complete(&mut conn,&actor).await?;
            if old["pendingRequests"]!=document["pendingRequests"] {validate_pending_requests(&old,&document,&actor)?;}
            if old["association"]!=document["association"] || old["legacyBranchRecovery"]!=document["legacyBranchRecovery"] { require_admin(&mut conn,&actor).await?; }
            let role:String=sqlx::query_scalar("SELECT role FROM users WHERE id=?").bind(&actor).fetch_one(&mut conn).await.map_err(|_| "Cannot verify local role")?;
            crate::transition_guard::validate(&old,&document,role=="admin",&actor)?;
        }
    }
    compare_and_swap(&mut conn, expected_revision, &document).await
}
#[tauri::command]
pub async fn list_local_users(app: tauri::AppHandle) -> Result<Vec<PublicUser>,String> {
    let mut conn=connect(&app_database(&app)?).await?;
    let rows=sqlx::query("SELECT id,username,role,name,EXISTS(SELECT 1 FROM settings WHERE key='password_rotation:'||users.id AND value='true') AS rotation FROM users ORDER BY name").fetch_all(&mut conn).await.map_err(|_| "Cannot read local accounts")?;
    Ok(rows.into_iter().map(|row| PublicUser{id:row.get("id"),username:row.get("username"),role:row.get("role"),name:row.get("name"),requires_password_change:row.get("rotation")}).collect())
}

#[tauri::command]
pub async fn change_local_password(app:tauri::AppHandle, session:tauri::State<'_,NativeSession>, password:String) -> Result<(),String> {
    let actor=session.0.lock().map_err(|_| "Local session unavailable")?.clone().ok_or("Sign in first")?;
    if password.chars().count()<12 || password.len()>1024 {return Err("Password must have at least 12 characters".into());}
    let hash=hash_password(&password)?;
    let mut conn=connect(&app_database(&app)?).await?;
    let mut tx=conn.begin_with("BEGIN IMMEDIATE").await.map_err(|_| "Database busy")?;
    sqlx::query("UPDATE users SET password=? WHERE id=?").bind(hash).bind(&actor).execute(&mut *tx).await.map_err(|_| "Cannot change password")?;
    sqlx::query("DELETE FROM settings WHERE key=?").bind(format!("password_rotation:{actor}")).execute(&mut *tx).await.map_err(|_| "Cannot complete password rotation")?;
    tx.commit().await.map_err(|_| "Cannot commit password change")?;
    *session.0.lock().map_err(|_| "Local session unavailable")?=None;
    Ok(())
}
#[tauri::command]
pub fn logout_local(session: tauri::State<'_,NativeSession>) -> Result<(),String> {
    *session.0.lock().map_err(|_| "Local session unavailable")?=None; Ok(())
}
async fn require_password_rotation_complete(conn:&mut SqliteConnection,actor:&str)->Result<(),String>{
    let pending:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM settings WHERE key=? AND value='true')").bind(format!("password_rotation:{actor}")).fetch_one(conn).await.map_err(|_|"Cannot verify password rotation")?;
    if pending{return Err("Change your existing account password before business changes".into());}Ok(())
}
pub(crate) async fn require_admin(conn:&mut SqliteConnection, actor:&str) -> Result<(),String> {
    require_password_rotation_complete(conn,actor).await?;
    let role:Option<String>=sqlx::query_scalar("SELECT role FROM users WHERE id=?").bind(actor).fetch_optional(conn).await.map_err(|_| "Cannot check permissions")?;
    if role.as_deref()!=Some("admin") {return Err("Administrator authorization required".into());} Ok(())
}
#[tauri::command]
pub async fn add_local_user(app:tauri::AppHandle, session:tauri::State<'_,NativeSession>, username:String, password:String, name:String, role:String) -> Result<(),String> {
    let actor=session.0.lock().map_err(|_| "Local session unavailable")?.clone().ok_or("Sign in first")?;
    if username.trim().is_empty() || name.trim().is_empty() || username.len()>100 || name.len()>200 || password.chars().count()<12 || password.len()>1024 || !["admin","cashier"].contains(&role.as_str()) {return Err("Valid account details and a password of at least 12 characters are required".into());}
    let hash=hash_password(&password)?;
    let mut conn=connect(&app_database(&app)?).await?;
    let mut tx=conn.begin_with("BEGIN IMMEDIATE").await.map_err(|_| "Database busy")?;
    require_admin(&mut tx,&actor).await?;
    let exists:i64=sqlx::query_scalar("SELECT count(*) FROM users WHERE lower(username)=lower(?)").bind(username.trim()).fetch_one(&mut *tx).await.map_err(|_| "Cannot check username")?;
    if exists>0 {return Err("Username already in use".into());}
    sqlx::query("INSERT INTO users(id,username,password,role,name) VALUES(lower(hex(randomblob(16))),?,?,?,?)")
        .bind(username.trim()).bind(hash).bind(role).bind(name.trim()).execute(&mut *tx).await.map_err(|_| "Cannot create account")?;
    tx.commit().await.map_err(|_| "Cannot commit account".into())
}
#[tauri::command]
pub async fn remove_local_user(app:tauri::AppHandle, session:tauri::State<'_,NativeSession>, id:String) -> Result<(),String> {
    let actor=session.0.lock().map_err(|_| "Local session unavailable")?.clone().ok_or("Sign in first")?;
    let mut conn=connect(&app_database(&app)?).await?;
    let mut tx=conn.begin_with("BEGIN IMMEDIATE").await.map_err(|_| "Database busy")?;
    require_admin(&mut tx,&actor).await?;
    let admins:i64=sqlx::query_scalar("SELECT count(*) FROM users WHERE role='admin' AND id<>?").bind(&id).fetch_one(&mut *tx).await.map_err(|_| "Cannot check administrators")?;
    if admins==0 || id==actor {return Err("Cannot remove the current or last administrator".into());}
    sqlx::query("DELETE FROM users WHERE id=?").bind(id).execute(&mut *tx).await.map_err(|_| "Cannot remove account")?;
    tx.commit().await.map_err(|_| "Cannot commit account change".into())
}
