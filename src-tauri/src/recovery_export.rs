use crate::{initialization, state_store};
use rand_core::OsRng;
use argon2::password_hash::SaltString;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::{Connection, SqliteConnection, sqlite::SqliteConnectOptions};
use std::{collections::BTreeMap, io::{Read, Write}, path::{Path, PathBuf}, time::{SystemTime, UNIX_EPOCH}};
use tauri::Manager;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupReceipt {
    pub id: String, pub directory: String, pub database: String,
    pub sha256: String, pub state_sha256: String, pub state_revision: i64,
}
fn digest(bytes: &[u8]) -> String { format!("{:x}", Sha256::digest(bytes)) }
fn file_digest(path:&Path)->Result<String,String>{
    let mut file=std::fs::File::open(path).map_err(|_| "Cannot read backup for checksum verification")?;
    let mut hasher=Sha256::new();let mut buffer=[0u8;65536];
    loop {let n=file.read(&mut buffer).map_err(|_| "Cannot finish backup checksum verification")?;if n==0{break;}hasher.update(&buffer[..n]);}
    Ok(format!("{:x}",hasher.finalize()))
}
async fn readonly(path: &Path) -> Result<SqliteConnection, String> {
    SqliteConnection::connect_with(&SqliteConnectOptions::new().filename(path).read_only(true))
        .await.map_err(|_| "Cannot read the existing SQLite file; no replacement was created".into())
}
async fn integrity(db: &mut SqliteConnection) -> Result<(), String> {
    let checks: Vec<String> = sqlx::query_scalar("PRAGMA integrity_check").fetch_all(&mut *db).await.map_err(|_| "Cannot check backup integrity")?;
    if checks != ["ok"] { return Err("SQLite integrity check failed; recovery stopped".into()); }
    if !sqlx::query("PRAGMA foreign_key_check").fetch_all(db).await.map_err(|_| "Cannot check backup relationships")?.is_empty() {
        return Err("SQLite foreign-key verification failed; recovery stopped".into());
    }
    Ok(())
}
pub(crate) fn backup_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    if let Some(profile)=initialization::qa_profile()? { return Ok(profile.join("exports")); }
    if let Some(profile)=initialization::development_profile()? { return Ok(profile.join("exports")); }
    Ok(app.path().document_dir().map_err(|_| "Cannot locate Documents; check Windows folder permissions")?.join("Swift Till Backups"))
}
pub(crate) async fn create_backup(source: &Path, folder: &Path, legacy_storage: BTreeMap<String,String>) -> Result<BackupReceipt,String> {
    const KEYS: &[&str] = &["pos_products","pos_sales","pos_refunds","pos_inventory_entries","pos_inventory_sync_outbox","pos_supabase_branch_association","pos_exchange_rate"];
    if legacy_storage.keys().any(|key| !KEYS.contains(&key.as_str()) && !(key.len()<=512 && (key.starts_with("pos_checkout_v3:")||key.starts_with("pos_pending_v3:")))) { return Err("Only legacy business storage may be included; cloud credentials are excluded".into()); }
    if !source.is_file() { return Err("Existing SQLite database was not found; export stopped without initialization".into()); }
    let timestamp=SystemTime::now().duration_since(UNIX_EPOCH).map_err(|_| "System clock is invalid")?.as_millis();
    let id=format!("export-{timestamp}-{}",SaltString::generate(&mut OsRng).as_str().replace(['/', '+'], "_"));
    std::fs::create_dir_all(folder).map_err(|_| "Cannot create backup folder; check Documents permissions and disk space")?;
    let directory=folder.join(&id);
    std::fs::create_dir(&directory).map_err(|_| "Cannot create unique backup; no previous backup was overwritten")?;
    let database=directory.join("pos_v2.db");
    let mut conn=readonly(source).await?;
    // SQLite owns the snapshot; committed WAL frames are included without raw file copying.
    sqlx::query("VACUUM INTO ?").bind(database.to_string_lossy().as_ref()).execute(&mut conn).await
        .map_err(|_| "Consistent SQLite export failed; check free disk space. No success was recorded")?;
    conn.close().await.map_err(|_| "Cannot close backup source")?;
    let mut copied=readonly(&database).await?;
    integrity(&mut copied).await?;
    let state=state_store::read_state(&mut copied).await?.ok_or("Durable POS state is missing; export requires review")?;
    copied.close().await.map_err(|_| "Cannot close verified backup")?;
    let bytes=std::fs::metadata(&database).map_err(|_| "Cannot inspect exported SQLite backup")?.len();
    let receipt=BackupReceipt { id, directory:directory.to_string_lossy().into(), database:database.to_string_lossy().into(),
        sha256:file_digest(&database)?, state_sha256:digest(state.to_string().as_bytes()), state_revision:state["revision"].as_i64().ok_or("Invalid state revision")? };
    let metadata=json!({"format":"swift-till-native-backup-v1","receipt":receipt,"identifier":"com.pos.dailys",
        "integrity":"ok","bytes":bytes,"association":state["association"],"pendingOperations":state["outbox"],
        "legacyStorage":legacy_storage,"containsPasswordHashes":true,"dedicatedCloudAuthStorageIncluded":false});
    let manifest=directory.join("manifest.json");
    let raw=serde_json::to_vec_pretty(&metadata).map_err(|_| "Cannot encode recovery metadata")?;
    let mut file=std::fs::OpenOptions::new().write(true).create_new(true).open(&manifest).map_err(|_| "Cannot create recovery metadata")?;
    file.write_all(&raw).and_then(|_|file.sync_all()).map_err(|_| "Cannot persist recovery metadata; export is incomplete")?;
    if std::fs::read(&manifest).map_err(|_| "Cannot read recovery metadata back")? != raw {
        return Err("Recovery metadata read-back failed".into());
    }
    if file_digest(&database)? != receipt.sha256 {
        return Err("Backup checksum verification failed".into());
    }
    Ok(receipt)
}
fn backup_path(folder:&Path,id:&str)->Result<PathBuf,String>{
    if !id.starts_with("export-") || id.len()>100 || !id.bytes().all(|b|b.is_ascii_alphanumeric() || b==b'-' || b==b'_') {
        return Err("Invalid verified backup reference".into());
    }
    Ok(folder.join(id))
}
pub(crate) async fn verify_backup(folder:&Path,id:&str)->Result<BackupReceipt,String>{
    let directory=backup_path(folder,id)?;
    let metadata:Value=serde_json::from_slice(&std::fs::read(directory.join("manifest.json")).map_err(|_| "Verified backup manifest is missing")?).map_err(|_| "Invalid backup manifest")?;
    if metadata["format"]!="swift-till-native-backup-v1" { return Err("Unsupported backup format".into()); }
    let receipt:BackupReceipt=serde_json::from_value(metadata["receipt"].clone()).map_err(|_| "Incomplete backup verification")?;
    let database=directory.join("pos_v2.db");
    if receipt.id!=id || Path::new(&receipt.database)!=database || Path::new(&receipt.directory)!=directory
        || file_digest(&database)?!=receipt.sha256 {
        return Err("Backup contents or identity changed; recovery refused".into());
    }
    let mut copy=readonly(&database).await?; integrity(&mut copy).await?;
    let saved=state_store::read_state(&mut copy).await?.ok_or("Backup state missing")?;
    if digest(saved.to_string().as_bytes())!=receipt.state_sha256 || saved["revision"]!=receipt.state_revision {
        return Err("Backup state verification failed".into());
    }
    Ok(receipt)
}
#[tauri::command]
pub async fn export_sqlite_recovery(app:tauri::AppHandle,session:tauri::State<'_,state_store::NativeSession>,legacy_storage:BTreeMap<String,String>)->Result<BackupReceipt,String>{
    let source=initialization::app_database(&app)?;
    let mut db=readonly(&source).await?;
    let actor=session.0.lock().map_err(|_| "Local session unavailable")?.clone().ok_or("Administrator login required")?;
    state_store::require_admin(&mut db,&actor).await?;
    create_backup(&source,&backup_root(&app)?,legacy_storage).await
}

pub(crate) fn recovered_state(old:&Value,association:&Value,receipt:&BackupReceipt,confirmation:&str)->Result<Value,String>{
    for key in ["businessId","branchId","ownerUserId","businessName","branchName"] {
        if association[key].as_str().map_or(true,|s|s.trim().is_empty()) {return Err("Verified business/branch association is incomplete".into());}
    }
    let business=association["businessId"].as_str().unwrap(); let branch=association["branchId"].as_str().unwrap();
    let key=format!("{business}/{branch}");
    if confirmation!=format!("{} / {}",association["businessName"].as_str().unwrap(),association["branchName"].as_str().unwrap()) {
        return Err("Explicit operator confirmation of the existing business and branch is required".into());
    }
    if !old["legacyBranchRecovery"].is_null() {
        if old["legacyBranchRecovery"]["backupId"]==receipt.id && old["association"]==*association { return Ok(old.clone()); }
        return Err("A different recovery is already recorded; manual reconciliation is required".into());
    }
    if old["revision"]!=receipt.state_revision || digest(old.to_string().as_bytes())!=receipt.state_sha256 {
        return Err("POS records changed after backup. Export a new verified backup before recovery".into());
    }
    if old["pendingRequests"].as_object().is_some_and(|requests|requests.values().any(|request|!request.is_null())) {
        return Err("Confirm unfinished saved transactions before changing their branch; original retry IDs are retained".into());
    }
    for (setting,expected) in [("business_id",business),("branch_id",branch)] {
        if let Some(retained)=old["project1Settings"][setting].as_str().filter(|s|!s.is_empty()) {
            if retained!=expected {return Err("Retained original branch ownership contradicts the selection; recovery requires review".into());}
        }
    }
    if !old["association"].is_null() && (old["association"]["businessId"]!=business || old["association"]["branchId"]!=branch) {
        return Err("Existing selected branch differs; automatic reassignment is prohibited".into());
    }
    let source=old["branches"]["unassigned"].as_object().ok_or("Original unassigned bucket is missing")?;
    let mut has_records=false;
    for field in ["products","entries","sales","refunds","heldSales"] {
        has_records |= source.get(field).and_then(Value::as_array).is_some_and(|rows|!rows.is_empty());
        if old["branches"][&key][field].as_array().is_some_and(|rows|!rows.is_empty()) {
            return Err("Destination already contains records. Reviewed merge is required; nothing was moved".into());
        }
    }
    if !has_records {return Err("No unassigned customer records require recovery".into());}
    if old["branches"][&key]["completed"].as_object().is_some_and(|rows|!rows.is_empty()) {
        return Err("Destination has transaction history; reviewed merge is required".into());
    }
    if let Some(target)=old["branches"][&key].as_object() {
        for (field,value) in target {
            if !["products","entries","sales","refunds","heldSales","completed"].contains(&field.as_str()) && source.get(field)!=Some(value) {
                return Err("Destination configuration differs from original records; reviewed merge is required".into());
            }
        }
    }
    let mut new=old.clone();
    let branches=new["branches"].as_object_mut().ok_or("Invalid branch data")?;
    let original=branches.remove("unassigned").unwrap(); branches.insert(key,original);
    new["association"]=association.clone(); new["revision"]=json!(receipt.state_revision+1);
    new["legacyBranchRecovery"]=json!({"backupId":receipt.id,"backupSHA256":receipt.sha256,"businessId":business,"branchId":branch,"reconciliationPending":true});
    new["recovery"].as_array_mut().ok_or("Invalid recovery audit")?.push(json!("Legacy branch attached after verified backup and explicit operator confirmation. Cloud synchronization remains paused; historical records and original pending IDs must be reconciled, never replayed."));
    // Whole-bucket transfer: exact original IDs, quantities, histories, settings,
    // completed requests and queued payloads. No sales or stock effects created.
    Ok(new)
}
pub(crate) async fn apply_recovery(db:&mut SqliteConnection,association:&Value,receipt:&BackupReceipt,confirmation:&str,actor:&str)->Result<Value,String>{
    let mut tx=db.begin_with("BEGIN IMMEDIATE").await.map_err(|_| "Database busy; retry the same reviewed recovery")?;
    state_store::require_admin(&mut tx,actor).await?;
    let old=state_store::read_state(&mut tx).await?.ok_or("Existing POS state missing")?;
    let new=recovered_state(&old,association,receipt,confirmation)?;
    if new!=old {
        let affected=sqlx::query("UPDATE pos_state SET revision=?,document=? WHERE id=1 AND revision=?")
            .bind(new["revision"].as_i64()).bind(new.to_string()).bind(old["revision"].as_i64())
            .execute(&mut *tx).await.map_err(|_| "Recovery failed; original records retained")?.rows_affected();
        if affected!=1 {return Err("Recovery state changed concurrently; nothing was committed".into());}
    }
    tx.commit().await.map_err(|_| "Recovery confirmation lost; retry with the same backup ID")?;
    Ok(new)
}
#[tauri::command]
pub async fn recover_legacy_branch(app:tauri::AppHandle,session:tauri::State<'_,state_store::NativeSession>,association:Value,backup_id:String,confirmation:String)->Result<Value,String>{
    let actor=session.0.lock().map_err(|_| "Local session unavailable")?.clone().ok_or("Administrator login required")?;
    let receipt=verify_backup(&backup_root(&app)?,&backup_id).await?;
    let source=initialization::app_database(&app)?;
    if !source.is_file() {return Err("Existing customer database missing; no replacement was created".into());}
    let mut db=initialization::connect(&source).await?;
    apply_recovery(&mut db,&association,&receipt,&confirmation,&actor).await
}

// Inventory-only activation never edits the archived bucket, financial history,
// receipts, completed requests or historical queue. It cannot be used to guess
// a remote baseline or remap product IDs by name/barcode.
fn inventory_book(products: &Value) -> Result<BTreeMap<String,Value>,String> {
    let mut result=BTreeMap::new(); let mut barcodes=std::collections::BTreeSet::new();
    for p in products.as_array().ok_or("Invalid inventory baseline")? {
        for field in ["id","name","barcode"] {
            if p[field].as_str().map_or(true,|v|v.trim().is_empty()) { return Err("Complete inventory identities are required".into()); }
        }
        let stock=p["stockQuantity"].as_i64().filter(|v|*v>=-2147483648 && *v<=2147483647).ok_or("Invalid inventory stock")?;
        for field in ["purchasePrice","salePrice"] {
            if p[field].as_f64().map_or(true,|v|!v.is_finite() || v<0.0) { return Err("Invalid inventory price".into()); }
        }
        let id=p["id"].as_str().unwrap().to_string();
        let book=json!({"id":id,"name":p["name"],"barcode":p["barcode"],"stockQuantity":stock,"purchasePrice":p["purchasePrice"].as_f64().unwrap(),"salePrice":p["salePrice"].as_f64().unwrap(),"isActive":p["isActive"]!=false});
        if !barcodes.insert(p["barcode"].as_str().unwrap()) || result.insert(id,book).is_some() { return Err("Duplicate inventory identity; reconcile before activation".into()); }
    }
    if result.is_empty() { return Err("No current inventory is available for verification".into()); }
    Ok(result)
}
pub(crate) fn inventory_activated_state(old:&Value,association:&Value,receipt:&BackupReceipt,confirmation:&str,cloud_products:&Value,allow_negative_stock:bool)->Result<Value,String>{
    if !old["inventoryActivation"].is_null() {
        if old["inventoryActivation"]["backupId"]==receipt.id && old["association"]==*association { return Ok(old.clone()); }
        return Err("Inventory already has an ownership claim; switching connections cannot claim it again".into());
    }
    if old["association"]!=*association || association["businessId"].as_str().map_or(true,|v|v.is_empty()) || association["branchId"].as_str().map_or(true,|v|v.is_empty()) || association["ownerUserId"].as_str().map_or(true,|v|v.is_empty()) {
        return Err("Save the authorized business and branch before inventory verification".into());
    }
    if confirmation!=format!("{} / {}",association["businessName"].as_str().unwrap_or(""),association["branchName"].as_str().unwrap_or("")) { return Err("Explicit confirmation of current inventory ownership is required".into()); }
    if old["revision"]!=receipt.state_revision || digest(old.to_string().as_bytes())!=receipt.state_sha256 { return Err("POS records changed after backup; export a fresh verified backup".into()); }
    if !old["legacyBranchRecovery"].is_null() { return Err("Previously recovered branch requires its separate reconciliation; inventory activation cannot clear that lock".into()); }
    if old["pendingRequests"].as_object().is_some_and(|r|r.values().any(|v|!v.is_null())) || old["branches"]["unassigned"]["heldSales"].as_array().is_some_and(|r|!r.is_empty()) { return Err("Unfinished original carts must be reviewed before inventory activation".into()); }
    let business=association["businessId"].as_str().unwrap(); let branch=association["branchId"].as_str().unwrap();
    for (field,expected) in [("business_id",business),("branch_id",branch)] {
        if old["project1Settings"][field].as_str().is_some_and(|v|!v.is_empty() && v!=expected) { return Err("Retained inventory ownership contradicts the selection; explicit reconciliation required".into()); }
    }
    let key=format!("{business}/{branch}");
    let target=&old["branches"][&key];
    if !target.is_object() || ["products","entries","sales","refunds","heldSales"].iter().any(|f|target[f].as_array().is_some_and(|r|!r.is_empty())) || ["completed","productAliases"].iter().any(|f|target[f].as_object().is_some_and(|r|!r.is_empty())) { return Err("Destination contains records; reviewed inventory merge required".into()); }
    let original=inventory_book(&old["branches"]["unassigned"]["products"])?;
    if original!=inventory_book(cloud_products)? { return Err("Cloud identities, prices or balances differ from current inventory; reconcile the exact differences before activation".into()); }
    let mut new=old.clone();
    let mut products=old["branches"]["unassigned"]["products"].clone();
    for product in products.as_array_mut().unwrap() { product["legacy"]=json!(false); }
    new["branches"][&key]["products"]=products;
    new["branches"][&key]["allowNegativeStock"]=json!(allow_negative_stock);
    new["inventoryActivation"]=json!({"businessId":business,"branchId":branch,"backupId":receipt.id,"backupSHA256":receipt.sha256,"inventorySHA256":digest(serde_json::to_string(&original).unwrap().as_bytes()),"historicalOperationIds":old["outbox"].as_array().ok_or("Invalid original queue")?.iter().map(|op|op["operationId"].clone()).collect::<Vec<_>>()});
    new["revision"]=json!(receipt.state_revision+1);
    new["recovery"].as_array_mut().ok_or("Invalid recovery audit")?.push(json!("Current inventory activated after verified SQLite backup, explicit administrator ownership confirmation and exact authorized cloud baseline comparison. Unassigned records remain immutable evidence; no original operation was replayed or acknowledged."));
    Ok(new)
}
pub(crate) async fn apply_inventory_activation(db:&mut SqliteConnection,association:&Value,receipt:&BackupReceipt,confirmation:&str,cloud_products:&Value,allow_negative_stock:bool,actor:&str)->Result<Value,String>{
    let mut tx=db.begin_with("BEGIN IMMEDIATE").await.map_err(|_|"Database busy; inventory activation was not committed")?;
    state_store::require_admin(&mut tx,actor).await?;
    let old=state_store::read_state(&mut tx).await?.ok_or("Existing POS state is missing")?;
    let manifest:Value=serde_json::from_slice(&std::fs::read(Path::new(&receipt.directory).join("manifest.json")).map_err(|_|"Verified backup manifest is missing")?).map_err(|_|"Invalid verified backup manifest")?;
    if let Some(storage)=manifest["legacyStorage"].as_object() {
        for (key,raw) in storage {
            if !(key.starts_with("pos_checkout_v3:") || key.starts_with("pos_pending_v3:")) {continue;}
            if old["pendingRequests"].get(key).is_some_and(Value::is_null) {continue;}
            let request:Value=serde_json::from_str(raw.as_str().ok_or("Invalid original saved request")?).map_err(|_|"Original saved request is damaged; preserve it for review")?;
            if !request.is_null() {return Err("Unfinished original transactions require review before inventory activation; original retry IDs are retained".into());}
        }
    }
    let new=inventory_activated_state(&old,association,receipt,confirmation,cloud_products,allow_negative_stock)?;
    if new!=old {
        let affected=sqlx::query("UPDATE pos_state SET revision=?,document=? WHERE id=1 AND revision=?").bind(new["revision"].as_i64()).bind(new.to_string()).bind(old["revision"].as_i64()).execute(&mut *tx).await.map_err(|_|"Inventory activation failed; original records retained")?.rows_affected();
        if affected!=1 { return Err("Inventory changed concurrently; activation was not committed".into()); }
    }
    tx.commit().await.map_err(|_|"Activation confirmation lost; retry with the original backup ID")?; Ok(new)
}
#[tauri::command]
pub async fn activate_verified_inventory(app:tauri::AppHandle,session:tauri::State<'_,state_store::NativeSession>,association:Value,backup_id:String,confirmation:String,cloud_products:Value,cloud_allow_negative_stock:bool)->Result<Value,String>{
    let actor=session.0.lock().map_err(|_|"Local session unavailable")?.clone().ok_or("Administrator login required")?;
    let receipt=verify_backup(&backup_root(&app)?,&backup_id).await?;
    let source=initialization::app_database(&app)?;
    if !source.is_file() { return Err("Existing POS database missing; no replacement was created".into()); }
    let mut db=initialization::connect(&source).await?;
    apply_inventory_activation(&mut db,&association,&receipt,&confirmation,&cloud_products,cloud_allow_negative_stock,&actor).await
}

#[cfg(test)]
mod tests {
    use super::*;
    fn association()->Value {json!({"businessId":"business","branchId":"main","ownerUserId":"owner","businessName":"Daily Supermarket","branchName":"Main Branch"})}
    fn original()->Value {
        json!({"version":2,"revision":0,"association":null,"branches":{"unassigned":{
            "products":[{"id":"original-product","barcode":"201","stockQuantity":67}],
            "entries":[{"id":"original-entry","productId":"original-product","quantityAdded":8}],
            "sales":(0..22220).map(|i|json!({"id":format!("historical-{i}"),"legacy":true,"total":2,"items":[]})).collect::<Vec<_>>(),
            "refunds":[{"id":"original-refund","legacy":true}],"heldSales":[],"completed":{"original-operation":{"request":"retained","result":"retained"}},"exchangeRate":89500}},
            "outbox":[{"operationId":"original-receipt-8","payload":"exact-original-receipt"},{"operationId":"original-sale-1","payload":"exact-original-sale"}],
            "project1Settings":{"device_id":"original-device"},"legacyStorageArchive":{"pos_sales":"preserved-original-json"},"users":[],"recovery":[]})
    }
    async fn fixture()->(PathBuf,SqliteConnection,Value){
        let directory=std::env::temp_dir().join(format!("swift-till-hotfix-{}",SaltString::generate(&mut OsRng).as_str().replace(['/', '+'],"_")));
        std::fs::create_dir(&directory).unwrap();let source=directory.join("source.db");
        let mut db=initialization::connect(&source).await.unwrap();
        sqlx::raw_sql(include_str!("../migrations/001_create_pos_tables.sql")).execute(&mut db).await.unwrap();
        sqlx::raw_sql(include_str!("../migrations/003_durable_state.sql")).execute(&mut db).await.unwrap();
        sqlx::query("INSERT INTO users VALUES('admin','fixture-admin','synthetic-hash','admin','Admin'),('cashier','fixture-cashier','synthetic-hash','cashier','Cashier')").execute(&mut db).await.unwrap();
        sqlx::query("PRAGMA journal_mode=WAL").execute(&mut db).await.unwrap();
        sqlx::query("PRAGMA wal_autocheckpoint=0").execute(&mut db).await.unwrap();
        let state=original();sqlx::query("INSERT INTO pos_state VALUES(1,0,?)").bind(state.to_string()).execute(&mut db).await.unwrap();
        (directory,db,state)
    }
    #[test]
    fn inventory_only_activation_preserves_history_and_supports_atomic_cash_sales_refunds_after_restart(){tauri::async_runtime::block_on(async {
        let (dir,mut db,mut old)=fixture().await;
        old["association"]=association();
        old["branches"]["unassigned"]["products"]=json!((0..243).map(|i|json!({"id":format!("p-{i}"),"name":format!("Product {i}"),"barcode":format!("barcode-{i}"),"stockQuantity":10,"purchasePrice":1,"salePrice":2,"legacy":true})).collect::<Vec<_>>());
        old["branches"]["business/main"]=json!({"products":[],"entries":[],"sales":[],"refunds":[],"heldSales":[],"completed":{},"exchangeRate":89500,"allowNegativeStock":true});
        sqlx::query("UPDATE pos_state SET document=? WHERE id=1").bind(old.to_string()).execute(&mut db).await.unwrap();
        let receipt=create_backup(&dir.join("source.db"),&dir.join("exports"),BTreeMap::new()).await.unwrap();
        let cloud=old["branches"]["unassigned"]["products"].clone();
        assert!(apply_inventory_activation(&mut db,&association(),&receipt,"Daily Supermarket / Main Branch",&cloud,false,"cashier").await.is_err());
        let mut mismatch=cloud.clone();mismatch[0]["stockQuantity"]=json!(9);
        assert!(apply_inventory_activation(&mut db,&association(),&receipt,"Daily Supermarket / Main Branch",&mismatch,false,"admin").await.is_err());
        let activated=apply_inventory_activation(&mut db,&association(),&receipt,"Daily Supermarket / Main Branch",&cloud,false,"admin").await.unwrap();
        for field in ["outbox","project1Settings","legacyStorageArchive","users"] {assert_eq!(activated[field],old[field]);}
        assert_eq!(activated["branches"]["unassigned"],old["branches"]["unassigned"]);
        assert_eq!(activated["branches"]["business/main"]["allowNegativeStock"],false);
        assert_eq!(activated["branches"]["unassigned"]["sales"].as_array().unwrap().len(),22220);
        assert_eq!(activated["branches"]["business/main"]["products"].as_array().unwrap().len(),243);
        assert_eq!(apply_inventory_activation(&mut db,&association(),&receipt,"Daily Supermarket / Main Branch",&cloud,false,"admin").await.unwrap(),activated);
        db.close().await.unwrap();let mut db=initialization::connect(&dir.join("source.db")).await.unwrap();
        assert_eq!(state_store::read_state(&mut db).await.unwrap().unwrap(),activated);
        let sale=json!({"id":"new-cash-sale","items":[{"productId":"p-0","quantity":2,"salePrice":2,"purchasePrice":1}],"subtotal":4,"total":4,"currency":"USD","exchangeRate":89500});
        let mut sold=activated.clone();sold["revision"]=json!(2);sold["branches"]["business/main"]["sales"]=json!([sale.clone()]);sold["branches"]["business/main"]["products"][0]["stockQuantity"]=json!(8);
        sold["outbox"].as_array_mut().unwrap().push(json!({"operationId":"sale:new-cash-sale","protocolRevision":3,"businessId":"business","branchId":"main","type":"sale","sale":sale}));
        crate::connection_safety::validate(&activated,&sold).unwrap();
        for admin in [false,true] {
            crate::transition_guard::validate(&activated,&sold,admin,"cashier").unwrap();
            let mut partial=sold.clone();partial["branches"]["business/main"]["products"][0]["stockQuantity"]=json!(10);
            assert!(crate::transition_guard::validate(&activated,&partial,admin,"cashier").is_err());
        }
        sqlx::query("CREATE TEMP TRIGGER simulate_disk_failure BEFORE UPDATE ON pos_state BEGIN SELECT RAISE(ABORT,'synthetic write failure'); END").execute(&mut db).await.unwrap();
        assert!(state_store::compare_and_swap(&mut db,1,&sold).await.is_err());
        assert_eq!(state_store::read_state(&mut db).await.unwrap().unwrap(),activated);
        sqlx::query("DROP TRIGGER simulate_disk_failure").execute(&mut db).await.unwrap();
        assert!(state_store::compare_and_swap(&mut db,1,&sold).await.unwrap());
        assert!(!state_store::compare_and_swap(&mut db,1,&sold).await.unwrap());
        let mut refunded=sold.clone();refunded["revision"]=json!(3);refunded["branches"]["business/main"]["products"][0]["stockQuantity"]=json!(9);
        let refund=json!({"id":"new-refund","saleId":"new-cash-sale","items":[{"productId":"p-0","quantity":1,"salePrice":2,"purchasePrice":1}],"totalRefunded":2,"currency":"USD","exchangeRate":89500});
        refunded["branches"]["business/main"]["refunds"]=json!([refund.clone()]);refunded["outbox"].as_array_mut().unwrap().push(json!({"operationId":"refund:new-refund","protocolRevision":3,"businessId":"business","branchId":"main","type":"refund","refund":refund}));
        crate::connection_safety::validate(&sold,&refunded).unwrap();crate::transition_guard::validate(&sold,&refunded,false,"cashier").unwrap();crate::transition_guard::validate(&sold,&refunded,true,"admin").unwrap();
        assert!(state_store::compare_and_swap(&mut db,2,&refunded).await.unwrap());
        let mut synced=refunded.clone();synced["outbox"]=old["outbox"].clone();synced["revision"]=json!(4);
        crate::connection_safety::validate(&refunded,&synced).unwrap();assert!(state_store::compare_and_swap(&mut db,3,&synced).await.unwrap());
        let mut replay=synced.clone();replay["outbox"]=json!([]);assert!(crate::connection_safety::validate(&synced,&replay).is_err());
        let mut forged=synced.clone();forged["inventoryActivation"]=Value::Null;assert!(crate::connection_safety::validate(&synced,&forged).is_err());
        let mut history=synced.clone();history["branches"]["unassigned"]["sales"][0]["total"]=json!(999);assert!(crate::connection_safety::validate(&synced,&history).is_err());
        let mut switched=synced.clone();switched["association"]["branchId"]=json!("another");switched["branches"]["business/another"]=activated["branches"]["business/main"].clone();assert!(crate::connection_safety::validate(&synced,&switched).is_err());
        let mut stale=old.clone();stale["revision"]=json!(1);assert!(inventory_activated_state(&stale,&association(),&receipt,"Daily Supermarket / Main Branch",&cloud,false).is_err());
        db.close().await.unwrap();let mut copy=readonly(&dir.join("source.db")).await.unwrap();integrity(&mut copy).await.unwrap();
        let saved=state_store::read_state(&mut copy).await.unwrap().unwrap();assert_eq!(saved,synced);assert_eq!(saved["branches"]["unassigned"],old["branches"]["unassigned"]);
        assert_eq!(saved["outbox"],old["outbox"]);assert_eq!(saved["branches"]["business/main"]["products"][0]["stockQuantity"],9);
    });}
    #[test]
    fn original_webview_pending_cart_blocks_inventory_activation_without_changing_any_records(){tauri::async_runtime::block_on(async {
        let (dir,mut db,mut old)=fixture().await;
        old["association"]=association();old["branches"]["business/main"]=json!({"products":[],"entries":[],"sales":[],"refunds":[],"completed":{}});
        old["branches"]["unassigned"]["products"][0]["name"]=json!("Coffee");old["branches"]["unassigned"]["products"][0]["purchasePrice"]=json!(1);old["branches"]["unassigned"]["products"][0]["salePrice"]=json!(2);
        sqlx::query("UPDATE pos_state SET document=? WHERE id=1").bind(old.to_string()).execute(&mut db).await.unwrap();
        let receipt=create_backup(&dir.join("source.db"),&dir.join("exports"),BTreeMap::from([("pos_checkout_v3:original:unassigned".into(),r#"{"id":"original-cart-id","payload":{"quantity":2}}"#.into())])).await.unwrap();
        let error=apply_inventory_activation(&mut db,&association(),&receipt,"Daily Supermarket / Main Branch",&old["branches"]["unassigned"]["products"],false,"admin").await.unwrap_err();
        assert!(error.contains("Unfinished original transactions"));assert_eq!(state_store::read_state(&mut db).await.unwrap().unwrap(),old);integrity(&mut db).await.unwrap();
    });}
    #[test]
    fn inventory_verification_rejects_conflicting_scope_duplicate_ids_and_remapping(){
        let mut old=original();old["association"]=association();old["branches"]["business/main"]=json!({"products":[],"entries":[],"sales":[],"refunds":[],"completed":{}});
        old["branches"]["unassigned"]["products"][0]["name"]=json!("Coffee");old["branches"]["unassigned"]["products"][0]["purchasePrice"]=json!(1);old["branches"]["unassigned"]["products"][0]["salePrice"]=json!(2);
        let receipt=BackupReceipt{id:"export-fixture".into(),directory:"fixture".into(),database:"fixture".into(),sha256:"a".repeat(64),state_sha256:digest(old.to_string().as_bytes()),state_revision:0};
        let original=old["branches"]["unassigned"]["products"].clone();
        for field in ["id","barcode","name","stockQuantity","purchasePrice","salePrice"] {
            let mut cloud=original.clone();cloud[0][field]=if ["stockQuantity","purchasePrice","salePrice"].contains(&field){json!(99)}else{json!("different")};
            assert!(inventory_activated_state(&old,&association(),&receipt,"Daily Supermarket / Main Branch",&cloud,false).is_err());
        }
        let mut duplicate=original.clone();duplicate.as_array_mut().unwrap().push(original[0].clone());assert!(inventory_book(&duplicate).is_err());
        let mut contradictory=old.clone();contradictory["project1Settings"]["branch_id"]=json!("another");let mut receipt=receipt;receipt.state_sha256=digest(contradictory.to_string().as_bytes());
        assert!(inventory_activated_state(&contradictory,&association(),&receipt,"Daily Supermarket / Main Branch",&original,false).unwrap_err().contains("contradicts"));
    }
    #[test]
    fn wal_backup_readback_and_transactional_recovery_preserve_22220_sales_and_pending_ids(){tauri::async_runtime::block_on(async {
        let (dir,mut db,old)=fixture().await;
        let receipt=create_backup(&dir.join("source.db"),&dir.join("exports"),BTreeMap::from([("pos_sales".into(),"preserved-original-json".into())])).await.unwrap();
        verify_backup(&dir.join("exports"),&receipt.id).await.unwrap();
        assert_eq!(state_store::read_state(&mut db).await.unwrap().unwrap(),old);
        assert!(apply_recovery(&mut db,&association(),&receipt,"Daily Supermarket / Main Branch","cashier").await.is_err());
        assert!(apply_recovery(&mut db,&association(),&receipt,"wrong confirmation","admin").await.is_err());
        assert_eq!(state_store::read_state(&mut db).await.unwrap().unwrap(),old);
        let recovered=apply_recovery(&mut db,&association(),&receipt,"Daily Supermarket / Main Branch","admin").await.unwrap();
        assert_eq!(recovered["branches"]["business/main"],old["branches"]["unassigned"]);
        assert_eq!(recovered["branches"]["business/main"]["sales"].as_array().unwrap().len(),22220);
        for field in ["outbox","project1Settings","legacyStorageArchive","users"] {assert_eq!(recovered[field],old[field]);}
        assert_eq!(recovered["legacyBranchRecovery"]["reconciliationPending"],true);
        assert_eq!(sqlx::query_scalar::<_,i64>("SELECT count(*) FROM users").fetch_one(&mut db).await.unwrap(),2);
        assert_eq!(apply_recovery(&mut db,&association(),&receipt,"Daily Supermarket / Main Branch","admin").await.unwrap(),recovered);
        db.close().await.unwrap();let mut reopened=readonly(&dir.join("source.db")).await.unwrap();
        assert_eq!(state_store::read_state(&mut reopened).await.unwrap().unwrap(),recovered);integrity(&mut reopened).await.unwrap();
    });}
    #[test]
    fn refuses_stale_backup_conflicting_ownership_and_nonempty_destination(){
        let old=original();let receipt=BackupReceipt{id:"export-fixture".into(),directory:"fixture".into(),database:"fixture".into(),sha256:"a".repeat(64),state_sha256:digest(old.to_string().as_bytes()),state_revision:0};
        let mut stale=old.clone();stale["revision"]=json!(1);
        assert!(recovered_state(&stale,&association(),&receipt,"Daily Supermarket / Main Branch").unwrap_err().contains("changed after backup"));
        for mut conflicting in [old.clone(),old.clone()] {
            if conflicting==old {conflicting["project1Settings"]["branch_id"]=json!("another-branch");}
            let mut current=receipt.clone();current.state_sha256=digest(conflicting.to_string().as_bytes());
            assert!(recovered_state(&conflicting,&association(),&current,"Daily Supermarket / Main Branch").is_err());
        }
        let mut target=old.clone();target["branches"]["business/main"]=old["branches"]["unassigned"].clone();
        let mut current=receipt.clone();current.state_sha256=digest(target.to_string().as_bytes());
        assert!(recovered_state(&target,&association(),&current,"Daily Supermarket / Main Branch").unwrap_err().contains("Destination already"));
    }
    #[test]
    fn rejects_corrupted_backup_missing_source_and_credential_metadata(){tauri::async_runtime::block_on(async {
        let (dir,_db,_)=fixture().await;
        assert!(create_backup(&dir.join("missing.db"),&dir.join("exports"),BTreeMap::new()).await.is_err());
        assert!(!dir.join("missing.db").exists());
        assert!(create_backup(&dir.join("source.db"),&dir.join("exports"),BTreeMap::from([("sb-project-auth-token".into(),"never-export-this".into())])).await.is_err());
        let receipt=create_backup(&dir.join("source.db"),&dir.join("exports"),BTreeMap::new()).await.unwrap();
        std::fs::write(&receipt.database,b"corrupt-copy-only").unwrap();
        assert!(verify_backup(&dir.join("exports"),&receipt.id).await.is_err());
        assert!(backup_path(&dir,"../../customer").is_err());
    });}
}
