use crate::{initialization, recovery_export, state_store};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::{Connection, Row, SqliteConnection, sqlite::SqliteConnectOptions};
use std::{collections::{BTreeMap, BTreeSet}, path::{Path, PathBuf}, time::{SystemTime, UNIX_EPOCH}};
use tauri::Manager;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LegacyProduct {
    pub id: String,
    pub barcode: String,
    pub name: String,
    pub stock_quantity: i64,
    pub purchase_price: f64,
    pub sale_price: f64,
    pub is_active: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyInventoryPreview {
    pub source_id: String,
    pub source_path: String,
    pub database_name: String,
    pub sha256: String,
    pub fingerprint: String,
    pub integrity: String,
    pub product_count: usize,
    pub active_product_count: usize,
    pub stock_quantity_sum: i64,
    pub sales_count: i64,
    pub refunds_count: i64,
    pub inventory_entry_count: i64,
    pub branch_assignments: Vec<String>,
    pub tax_columns: Vec<String>,
    pub products: Vec<LegacyProduct>,
}

fn sha(bytes: &[u8]) -> String { format!("{:x}", Sha256::digest(bytes)) }
fn file_sha(path: &Path) -> Result<String, String> {
    let bytes=std::fs::read(path).map_err(|_| "Cannot read the legacy database for verification")?;
    Ok(sha(&bytes))
}
fn source_id(path: &Path) -> String { sha(path.to_string_lossy().to_lowercase().as_bytes()) }
fn source_scope_key(source:&LegacyInventoryPreview)->String{let mut scopes=source.branch_assignments.iter().map(|scope|if scope.starts_with("unassigned"){"unassigned".to_string()}else{scope.clone()}).collect::<Vec<_>>();scopes.sort();let mut tax=source.tax_columns.clone();tax.sort();sha(&serde_json::to_vec(&(source.fingerprint.clone(),scopes,tax)).unwrap_or_default())}
fn source_scope_conflicts(source:&LegacyInventoryPreview,business:&str,branch:&str)->bool{let selected=format!("{business}/{branch}");source.branch_assignments.iter().any(|scope|if scope.is_empty()||scope.starts_with("unassigned"){false}else if scope.contains('/') {scope!=&selected}else{scope!=branch})}
async fn table_exists(db: &mut SqliteConnection, table: &str) -> Result<bool,String> {
    let exists:i64=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=? COLLATE NOCASE)")
        .bind(table).fetch_one(db).await.map_err(|_| "Cannot inspect the legacy database schema")?;
    Ok(exists!=0)
}
async fn columns(db: &mut SqliteConnection, table: &str) -> Result<BTreeMap<String,String>,String> {
    let rows=sqlx::query(&format!("PRAGMA table_info(\"{}\")",table.replace('"',""))).fetch_all(db).await
        .map_err(|_| "Cannot inspect legacy table columns")?;
    Ok(rows.into_iter().map(|r| { let name:String=r.get("name"); (name.to_lowercase(),name) }).collect())
}
fn get_column(columns:&BTreeMap<String,String>, names:&[&str])->Option<String>{ names.iter().find_map(|n|columns.get(*n).cloned()) }
async fn count_table(db:&mut SqliteConnection, table:&str)->Result<i64,String>{
    if !table_exists(db,table).await? {return Ok(0)}
    sqlx::query_scalar(&format!("SELECT count(*) FROM \"{}\"",table)).fetch_one(db).await.map_err(|_|"Cannot count legacy records".into())
}
async fn tax_metadata(db:&mut SqliteConnection)->Result<Vec<String>,String>{
    if !table_exists(db,"settings").await?{return Ok(vec![])}
    let cols=columns(db,"settings").await?;let mut found=cols.keys().filter(|name|name.contains("tax")).map(|name|format!("settings.{}",cols[name])).collect::<Vec<_>>();
    if let Some(key)=get_column(&cols,&["key","name"]){let query=format!("SELECT CAST(\"{}\" AS TEXT) FROM settings WHERE lower(CAST(\"{}\" AS TEXT)) LIKE '%tax%' LIMIT 100",key,key);let rows=sqlx::query_scalar::<_,String>(&query).fetch_all(db).await.map_err(|_|"Cannot inspect legacy tax-setting names")?;found.extend(rows.into_iter().map(|name|format!("settings.{name}")));}
    found.sort();found.dedup();Ok(found)
}
async fn preview_database(path:&Path)->Result<LegacyInventoryPreview,String>{
    let path=path.canonicalize().map_err(|_|"Legacy database path is unavailable")?;
    let opts=SqliteConnectOptions::new().filename(&path).read_only(true).busy_timeout(std::time::Duration::from_secs(5));
    let mut db=SqliteConnection::connect_with(&opts).await.map_err(|_|"Cannot open legacy database read-only")?;
    sqlx::query("PRAGMA query_only=ON").execute(&mut db).await.map_err(|_|"Cannot enforce read-only legacy inspection")?;
    let check:Vec<String>=sqlx::query_scalar("PRAGMA integrity_check").fetch_all(&mut db).await.map_err(|_|"Legacy SQLite integrity check could not run")?;
    if check!=["ok"] {return Err("Legacy SQLite integrity failed; inventory import is blocked".into())}
    let source_hash=file_sha(&path)?;
    if table_exists(&mut db,"pos_state").await? {
        let document:Option<String>=sqlx::query_scalar("SELECT document FROM pos_state WHERE id=1").fetch_optional(&mut db).await.map_err(|_|"Cannot read current durable inventory state")?;
        if let Some(document)=document {
            let state:Value=serde_json::from_str(&document).map_err(|_|"Durable legacy state is damaged; inventory import is blocked")?;
            let branches=state["branches"].as_object().ok_or("Durable branch map is missing")?;
            let populated=branches.iter().filter(|(_,branch)|branch["products"].as_array().is_some_and(|rows|!rows.is_empty())).collect::<Vec<_>>();
            if populated.len()>1{return Err("Legacy durable database has products in multiple branch buckets; choose an explicitly reviewed source scope before import".into())}
            if let Some((scope,branch))=populated.first() {
                let mut products:Vec<LegacyProduct>=serde_json::from_value(branch["products"].clone()).map_err(|_|"Durable legacy product fields are unsupported")?;
                products.sort_by(|a,b|a.id.cmp(&b.id));
                let sales_count=branches.values().map(|b|b["sales"].as_array().map_or(0,|v|v.len() as i64)).sum();
                let refunds_count=branches.values().map(|b|b["refunds"].as_array().map_or(0,|v|v.len() as i64)).sum();
                let entries=branch["entries"].as_array().map_or(0,|v|v.len() as i64);
                let raw=serde_json::to_vec(&products).map_err(|_|"Cannot fingerprint durable inventory")?;
                let mut tax_columns=branch["products"].as_array().into_iter().flatten().filter_map(Value::as_object).flat_map(|p|p.keys().filter(|key|key.to_lowercase().contains("tax")).map(|key|format!("products.{key}")).collect::<Vec<_>>()).collect::<Vec<_>>();
                if let Some(settings)=state["project1Settings"].as_object(){tax_columns.extend(settings.keys().filter(|key|key.to_lowercase().contains("tax")).map(|key|format!("project1Settings.{key}")));}
                tax_columns.sort();tax_columns.dedup();
                let mut assignments=vec![(*scope).clone()];
                if let Some(settings)=state["project1Settings"].as_object(){let business=settings.get("business_id").and_then(Value::as_str);let branch=settings.get("branch_id").and_then(Value::as_str);if business.is_some()||branch.is_some(){assignments.push(format!("{}/{}",business.unwrap_or("*"),branch.unwrap_or("*")));}}
                let mut preview=LegacyInventoryPreview{source_id:source_id(&path),source_path:path.to_string_lossy().into_owned(),database_name:path.file_name().unwrap_or_default().to_string_lossy().into_owned(),sha256:source_hash,fingerprint:sha(&raw),integrity:"ok".into(),product_count:products.len(),active_product_count:products.iter().filter(|p|p.is_active).count(),stock_quantity_sum:products.iter().map(|p|p.stock_quantity).sum(),sales_count,refunds_count,inventory_entry_count:entries,branch_assignments:assignments,tax_columns,products};
                let unique:BTreeSet<_>=preview.products.iter().map(|p|p.id.as_str()).collect();
                if unique.len()!=preview.products.len(){return Err("Durable source contains duplicate product IDs".into())}
                preview.sha256=file_sha(&path)?;
                db.close().await.map_err(|_|"Cannot close legacy database")?;
                return Ok(preview)
            }
            let empty_products:Vec<LegacyProduct>=Vec::new();
            let raw=serde_json::to_vec(&empty_products).map_err(|_|"Cannot fingerprint empty inventory")?;
            let preview=LegacyInventoryPreview{source_id:source_id(&path),source_path:path.to_string_lossy().into_owned(),database_name:path.file_name().unwrap_or_default().to_string_lossy().into_owned(),sha256:source_hash,fingerprint:sha(&raw),integrity:"ok".into(),product_count:0,active_product_count:0,stock_quantity_sum:0,sales_count:0,refunds_count:0,inventory_entry_count:0,branch_assignments:vec![],tax_columns:vec![],products:empty_products};
            db.close().await.map_err(|_|"Cannot close legacy database")?;
            return Ok(preview)
        }
    }
    if !table_exists(&mut db,"products").await? {return Err("This database has no products table; no inventory was inferred".into())}
    let cols=columns(&mut db,"products").await?;
    let id=get_column(&cols,&["id"]).ok_or("Legacy products table lacks product IDs")?;
    let barcode=get_column(&cols,&["barcode"]).ok_or("Legacy products table lacks barcodes")?;
    let name=get_column(&cols,&["name"]).ok_or("Legacy products table lacks product names")?;
    let stock=get_column(&cols,&["stockquantity","stock_quantity"]).ok_or("Legacy products table lacks stock quantities")?;
    let purchase=get_column(&cols,&["purchaseprice","purchase_price"]).ok_or("Legacy products table lacks purchase prices")?;
    let sale=get_column(&cols,&["saleprice","sale_price"]).ok_or("Legacy products table lacks sale prices")?;
    let active=get_column(&cols,&["isactive","is_active"]);
    let assignments:Vec<String>=if let Some(branch_col)=get_column(&cols,&["branchid","branch_id"]) {
        let rows=sqlx::query(&format!("SELECT DISTINCT COALESCE(CAST(\"{}\" AS TEXT),'') FROM products ORDER BY 1",branch_col)).fetch_all(&mut db).await.map_err(|_|"Cannot inspect legacy product branch assignments")?;
        rows.into_iter().map(|r|r.get::<String,_>(0)).collect()
    } else { vec!["unassigned (source schema has no branch column)".into()] };
    let mut tax_columns=cols.keys().filter(|name|name.contains("tax")).filter_map(|key|cols.get(key).cloned().map(|column|format!("products.{column}"))).collect::<Vec<_>>();
    tax_columns.extend(tax_metadata(&mut db).await?);
    tax_columns.sort();tax_columns.dedup();
    // Tax columns are reported in the preview; import_state blocks them because
    // the operational Product model cannot preserve their values.
    let active_expr=active.map(|c|format!("COALESCE(\"{}\",1)",c)).unwrap_or_else(||"1".into());
    let query=format!("SELECT CAST(\"{id}\" AS TEXT) id,CAST(\"{barcode}\" AS TEXT) barcode,CAST(\"{name}\" AS TEXT) name,CAST(\"{stock}\" AS INTEGER) stock,CAST(\"{purchase}\" AS REAL) purchase,CAST(\"{sale}\" AS REAL) sale,{active_expr} active FROM products ORDER BY id");
    let rows=sqlx::query(&query).fetch_all(&mut db).await.map_err(|_|"Cannot read legacy products")?;
    if rows.len()>10000 {return Err("Legacy product count exceeds the reviewed import limit; use a staged reconciliation".into())}
    let mut products=Vec::with_capacity(rows.len()); let mut ids=BTreeSet::new(); let mut barcodes=BTreeSet::new();
    for row in rows {
        let item=LegacyProduct { id:row.try_get("id").map_err(|_|"Invalid legacy product ID")?, barcode:row.try_get("barcode").map_err(|_|"Invalid legacy barcode")?, name:row.try_get("name").map_err(|_|"Invalid legacy product name")?, stock_quantity:row.try_get("stock").map_err(|_|"Invalid legacy stock quantity")?, purchase_price:row.try_get("purchase").map_err(|_|"Invalid legacy purchase price")?, sale_price:row.try_get("sale").map_err(|_|"Invalid legacy sale price")?, is_active:row.try_get::<i64,_>("active").map_err(|_|"Invalid legacy product status")?!=0 };
        if item.id.trim().is_empty()||item.barcode.trim().is_empty()||item.name.trim().is_empty()||item.stock_quantity < -2147483648||item.stock_quantity>2147483647||!item.purchase_price.is_finite()||item.purchase_price<0.0||!item.sale_price.is_finite()||item.sale_price<0.0 {return Err("Legacy product has invalid identity, quantity, or price; import stopped".into())}
        if !ids.insert(item.id.clone())||!barcodes.insert(item.barcode.clone()){return Err("Legacy database has duplicate product IDs or barcodes; reconcile before import".into())}
        products.push(item);
    }
    if products.is_empty(){return Err("No products were found in this database".into())}
    let sales=count_table(&mut db,"sales").await?; let refunds=count_table(&mut db,"refunds").await?; let entries=count_table(&mut db,"inventory_entries").await?;
    db.close().await.map_err(|_|"Cannot close read-only legacy database")?;
    let raw=serde_json::to_vec(&products).map_err(|_|"Cannot fingerprint legacy inventory")?;
    Ok(LegacyInventoryPreview {source_id:source_id(&path),source_path:path.to_string_lossy().into_owned(),database_name:path.file_name().unwrap_or_default().to_string_lossy().into_owned(),sha256:source_hash,fingerprint:sha(&raw),integrity:"ok".into(),product_count:products.len(),active_product_count:products.iter().filter(|p|p.is_active).count(),stock_quantity_sum:products.iter().map(|p|p.stock_quantity).sum(),sales_count:sales,refunds_count:refunds,inventory_entry_count:entries,branch_assignments:assignments,tax_columns,products})
}
fn candidate_paths(app:&tauri::AppHandle)->Result<Vec<PathBuf>,String>{
    let mut roots=Vec::new();
    let roaming=std::env::var_os("APPDATA").map(PathBuf::from).ok_or("Windows roaming AppData is unavailable")?;
    roots.push(roaming.join("com.dailys.pos"));
    roots.push(app.path().app_config_dir().map_err(|_|"Cannot resolve current POS data directory")?);
    let mut found=BTreeSet::new();let mut paths=Vec::new();
    for root in roots { for name in ["pos.db","pos_v2.db"] {let path=root.join(name);if path.is_file(){let canonical=path.canonicalize().map_err(|_|"Cannot resolve existing candidate database")?;if found.insert(canonical.clone()){paths.push(canonical)}}}}
    Ok(paths)
}
#[tauri::command]
pub async fn discover_legacy_inventory(app:tauri::AppHandle)->Result<Vec<LegacyInventoryPreview>,String>{
    let mut candidates=Vec::new();for path in candidate_paths(&app)? {match preview_database(&path).await{Ok(source)=>candidates.push(source),Err(error)=>return Err(format!("Cannot safely determine authoritative inventory across all existing database files ({}): {error}",path.display()))}}
    Ok(candidates)
}

fn canonical_products(products:&[LegacyProduct])->Result<Vec<Value>,String>{
    let mut out=products.iter().map(|p|json!({"id":p.id,"barcode":p.barcode,"name":p.name,"stockQuantity":p.stock_quantity,"purchasePrice":p.purchase_price,"salePrice":p.sale_price,"isActive":p.is_active})).collect::<Vec<_>>();
    out.sort_by(|a,b|a["id"].as_str().cmp(&b["id"].as_str()));
    if out.windows(2).any(|pair|pair[0]["id"]==pair[1]["id"]){return Err("Duplicate legacy product identity".into())}
    Ok(out)
}
fn product_map(products:&Value)->Result<BTreeMap<String,Value>,String>{
    let rows=products.as_array().ok_or("Invalid cloud inventory baseline")?;let mut map=BTreeMap::new();let mut barcodes=BTreeSet::new();
    for p in rows {
        let id=p["id"].as_str().filter(|s|!s.trim().is_empty()).ok_or("Cloud product ID is missing")?.to_string();
        let barcode=p["barcode"].as_str().filter(|s|!s.trim().is_empty()).ok_or("Cloud barcode is missing")?;
        let name=p["name"].as_str().filter(|s|!s.trim().is_empty()).ok_or("Cloud product name is missing")?;
        let stock=p["stockQuantity"].as_i64().filter(|n|*n>=-2147483648&&*n<=2147483647).ok_or("Cloud stock quantity is invalid")?;
        let purchase=p["purchasePrice"].as_f64().filter(|n|n.is_finite()&&*n>=0.0).ok_or("Cloud purchase price is invalid")?;
        let sale=p["salePrice"].as_f64().filter(|n|n.is_finite()&&*n>=0.0).ok_or("Cloud sale price is invalid")?;
        let normalized=json!({"id":id,"barcode":barcode,"name":name,"stockQuantity":stock,"purchasePrice":purchase,"salePrice":sale,"isActive":p["isActive"]!=false});
        if !barcodes.insert(barcode.to_string())||map.insert(id,normalized).is_some(){return Err("Cloud inventory has duplicate identity; reconcile before import".into())}
    }
    Ok(map)
}
fn branch_empty(branch:&Value)->bool{["products","entries","sales","refunds","heldSales"].iter().all(|f|branch[*f].as_array().map_or(true,|v|v.is_empty())) && ["completed","productAliases"].iter().all(|f|branch[*f].as_object().map_or(true,|v|v.is_empty()))}
pub(crate) fn import_state(old:&Value,association:&Value,receipt:&recovery_export::BackupReceipt,confirmation:&str,source:&LegacyInventoryPreview,cloud_products:&Value,allow_negative_stock:bool)->Result<Value,String>{
    if !source.tax_columns.is_empty(){return Err(format!("Legacy products contain tax fields not represented by the POS product model ({}). Original data is untouched; review the tax mapping before import",source.tax_columns.join(", ")))}
    if association["businessId"].as_str().map_or(true,|v|v.is_empty())||association["branchId"].as_str().map_or(true,|v|v.is_empty())||association["ownerUserId"].as_str().map_or(true,|v|v.is_empty()){return Err("Save the authorized business and branch first".into())}
    if old["association"]!=*association{return Err("Saved business/branch changed; refresh and retry".into())}
    if confirmation!=format!("{} / {}",association["businessName"].as_str().unwrap_or(""),association["branchName"].as_str().unwrap_or("")){return Err("Type the exact selected business / branch to confirm current inventory ownership".into())}
    let selected_branch=association["branchId"].as_str().unwrap();
    if source_scope_conflicts(source,association["businessId"].as_str().unwrap(),selected_branch){return Err("Legacy database records a different business/branch assignment. Administrator confirmation cannot override contradictory stored ownership; reviewed reconciliation required".into())}
    let selected=format!("{}/{}",association["businessId"].as_str().unwrap(),association["branchId"].as_str().unwrap());
    let target=&old["branches"][&selected];
    let source_products=canonical_products(&source.products)?; let source_map=product_map(&Value::Array(source_products.clone()))?;
    if !old["inventoryActivation"].is_null(){
        let proof=&old["inventoryActivation"];
        if proof["sourceFingerprint"]==source.fingerprint&&proof["businessId"]==association["businessId"]&&proof["branchId"]==association["branchId"]&&proof["inventoryImport"]==true{return Ok(old.clone())}
        return Err("Inventory ownership is already recorded for another source or branch; reviewed reconciliation required".into())
    }
    let cloud_map=product_map(cloud_products)?;
    if source_map!=cloud_map{return Err("Legacy source and authorized cloud inventory differ by IDs, barcodes, prices, active status, or stock. Nothing was imported; review exact differences first".into())}
    if old["revision"]!=receipt.state_revision||sha(old.to_string().as_bytes())!=receipt.state_sha256{return Err("Destination changed after backup; export a fresh verified backup".into())}
    if old["legacyBranchRecovery"]["reconciliationPending"]==true{return Err("An existing history recovery lock must be resolved before inventory activation".into())}
    if old["pendingRequests"].as_object().is_some_and(|r|r.values().any(|v|!v.is_null())){return Err("Unfinished local transactions require review before importing inventory".into())}
    let original=&old["branches"]["unassigned"];
    if original["heldSales"].as_array().is_some_and(|r|!r.is_empty()){return Err("An unfinished held sale exists in the legacy bucket; review it before import".into())}
    if !branch_empty(target){
        let existing=product_map(&target["products"])?;
        if existing!=source_map||["entries","sales","refunds","heldSales"].iter().any(|field|target[*field].as_array().is_some_and(|v|!v.is_empty()))||["completed","productAliases"].iter().any(|field|target[*field].as_object().is_some_and(|v|!v.is_empty())){return Err("Destination branch has inventory or history that differs from the legacy baseline; reviewed reconciliation required".into())}
    }
    let mut new=old.clone();
    let branch=new["branches"].as_object_mut().ok_or("Invalid destination branches")?.entry(selected.clone()).or_insert_with(||json!({"products":[],"entries":[],"sales":[],"refunds":[],"heldSales":[],"completed":{},"exchangeRate":89500,"allowNegativeStock":true,"productAliases":{}}));
    branch["products"]=Value::Array(source_products.clone());
    branch["allowNegativeStock"]=json!(allow_negative_stock);
    // An opening balance is a matched baseline, never a receipt or stock delta.
    let old_ops=old["outbox"].as_array().ok_or("Invalid original queue")?;
    new["inventoryActivation"]=json!({"businessId":association["businessId"],"branchId":association["branchId"],"backupId":receipt.id,"backupSHA256":receipt.sha256,"inventorySHA256":source.fingerprint,"historicalOperationIds":old_ops.iter().map(|op|op["operationId"].clone()).collect::<Vec<_>>(),"sourceFingerprint":source.fingerprint,"sourcePath":source.source_path,"sourceDatabaseSHA256":source.sha256,"sourceProductCount":source.product_count,"sourceStockQuantitySum":source.stock_quantity_sum,"inventoryImport":true});
    new["revision"]=json!(receipt.state_revision+1);
    new["recovery"].as_array_mut().ok_or("Invalid recovery audit")?.push(json!(format!("Imported {} products as a verified opening inventory baseline for {}/{}. No legacy sales, refunds, inventory movements, users or queues were imported or replayed.",source.product_count,association["businessName"],association["branchName"])));
    Ok(new)
}

async fn source_by_id(app:&tauri::AppHandle,id:&str)->Result<LegacyInventoryPreview,String>{
    for path in candidate_paths(app)? {if source_id(&path)==id{return preview_database(&path).await}}
    Err("Legacy source changed or is no longer in an approved AppData location; rescan before importing".into())
}
fn copy_tree(source:&Path,destination:&Path)->Result<(u64,String),String>{
    let meta=std::fs::symlink_metadata(source).map_err(|_|"Cannot inspect legacy WebView storage")?;
    if meta.file_type().is_symlink(){return Err("Legacy WebView storage contains a link; backup stopped for review".into())}
    if meta.is_dir(){
        std::fs::create_dir_all(destination).map_err(|_|"Cannot create WebView backup directory")?;
        let mut files=0u64;let mut digest_rows=Vec::new();
        for entry in std::fs::read_dir(source).map_err(|_|"Cannot enumerate legacy WebView storage")?{
            let entry=entry.map_err(|_|"Cannot enumerate legacy WebView storage")?;let name=entry.file_name();
            let (count,hash)=copy_tree(&entry.path(),&destination.join(&name))?;files+=count;digest_rows.push((name.to_string_lossy().to_string(),hash));
        }
        digest_rows.sort();let encoded=serde_json::to_vec(&digest_rows).map_err(|_|"Cannot verify WebView backup")?;
        Ok((files,sha(&encoded)))
    }else if meta.is_file(){
        let data=std::fs::read(source).map_err(|_|"Cannot read legacy WebView storage; do not import until it is closed and accessible")?;
        if data.len()>64*1024*1024{return Err("A single legacy WebView storage file exceeds the backup safety limit".into())}
        let mut out=std::fs::OpenOptions::new().write(true).create_new(true).open(destination).map_err(|_|"Cannot create a unique WebView backup copy")?;
        use std::io::Write;out.write_all(&data).and_then(|_|out.sync_all()).map_err(|_|"WebView backup write failed")?;
        let copy=std::fs::read(destination).map_err(|_|"Cannot read WebView backup back")?;
        if data!=copy{return Err("WebView backup verification failed".into())}
        Ok((1,sha(&data)))
    }else{Err("Unsupported file in legacy WebView storage".into())}
}
fn backup_legacy_webview(app:&tauri::AppHandle,directory:&Path)->Result<Vec<Value>,String>{
    let Some(local)=std::env::var_os("LOCALAPPDATA").map(PathBuf::from) else{return Ok(vec![])};
    let root=local.join("com.dailys.pos");
    let candidates=[
        root.join("EBWebView/Default/Local Storage/leveldb"),
        root.join("WebView/Default/Local Storage/leveldb"),
        root.join("Default/Local Storage/leveldb"),
        root.join("EBWebView/Default/IndexedDB"),
        root.join("Default/IndexedDB"),
    ];
    let mut manifest=Vec::new();let mut total=0u64;
    for (index,path) in candidates.iter().enumerate(){
        if !path.exists(){continue}
        let target=directory.join(format!("legacy-webview-storage-{index}"));
        let (count,hash)=copy_tree(path,&target)?;total+=count;
        if total>10000{return Err("Legacy WebView backup exceeded the file limit; inventory import stopped".into())}
        manifest.push(json!({"source":path,"backup":target,"fileCount":count,"sha256":hash}));
    }
    let _=app;
    Ok(manifest)
}
async fn backup_source(app:&tauri::AppHandle,preview:&LegacyInventoryPreview)->Result<(PathBuf,String),String>{
    let root=app.path().document_dir().map_err(|_|"Cannot locate the private backup folder")?.join("Swift Till Backups");
    let stamp=SystemTime::now().duration_since(UNIX_EPOCH).map_err(|_|"System time unavailable")?.as_millis();
    let directory=root.join(format!("legacy-inventory-{}-{stamp}",&preview.source_id[..16]));
    std::fs::create_dir_all(&directory).map_err(|_|"Cannot create legacy inventory backup folder")?;
    let backup=directory.join(&preview.database_name);
    let mut db=SqliteConnection::connect_with(&SqliteConnectOptions::new().filename(&preview.source_path).read_only(true).busy_timeout(std::time::Duration::from_secs(5))).await.map_err(|_|"Cannot reopen legacy database read-only for backup")?;
    sqlx::query("VACUUM INTO ?").bind(backup.to_string_lossy().as_ref()).execute(&mut db).await.map_err(|_|"Consistent legacy SQLite backup failed; inventory was not imported")?;
    db.close().await.map_err(|_|"Cannot close legacy backup source")?;
    let mut copy=SqliteConnection::connect_with(&SqliteConnectOptions::new().filename(&backup).read_only(true)).await.map_err(|_|"Cannot reopen legacy backup")?;
    let check:Vec<String>=sqlx::query_scalar("PRAGMA integrity_check").fetch_all(&mut copy).await.map_err(|_|"Legacy backup integrity check failed")?;
    if check!=["ok"]{return Err("Legacy backup integrity failed; inventory was not imported".into())}
    copy.close().await.map_err(|_|"Cannot close verified legacy backup")?;
    let digest=file_sha(&backup)?;
    let after=preview_database(Path::new(&preview.source_path)).await?;
    if after.sha256!=preview.sha256||after.fingerprint!=preview.fingerprint||file_sha(&backup)?!=digest{return Err("Legacy source changed during backup; import stopped".into())}
    let webview=backup_legacy_webview(app,&directory)?;
    let manifest=json!({"format":"swift-till-legacy-inventory-source-v1","sourcePath":preview.source_path,"sourceId":preview.source_id,"sourceSHA256":preview.sha256,"backupFile":backup,"backupSHA256":digest,"integrity":"ok","products":preview.product_count,"stockQuantitySum":preview.stock_quantity_sum,"historicalSalesPreservedInSourceOnly":preview.sales_count,"historicalRefundsPreservedInSourceOnly":preview.refunds_count,"historicalTransactionsImported":false,"pendingOperationsImported":false,"legacyWebViewCopies":webview,"currentWebViewLegacyKeys":"Included in the separate destination SQLite recovery backup."});
    let manifest_path=directory.join("manifest.json");
    let raw=serde_json::to_vec_pretty(&manifest).map_err(|_|"Cannot encode legacy backup manifest")?;
    std::fs::write(&manifest_path,&raw).map_err(|_|"Cannot save legacy source backup manifest")?;
    if std::fs::read(&manifest_path).map_err(|_|"Cannot verify legacy manifest")?!=raw||file_sha(&backup)?!=digest{return Err("Legacy source backup read-back failed".into())}
    Ok((backup,digest))
}
#[tauri::command]
pub async fn import_legacy_inventory(app:tauri::AppHandle,session:tauri::State<'_,state_store::NativeSession>,source_id:String,association:Value,backup_id:String,confirmation:String,cloud_products:Value,cloud_allow_negative_stock:bool)->Result<Value,String>{
    let actor=session.0.lock().map_err(|_|"Local session unavailable")?.clone().ok_or("Administrator login required")?;
    let source=source_by_id(&app,&source_id).await?;
    if source.product_count==0{return Err("Selected source has no products; no inventory was imported".into())}
    let others=candidate_paths(&app)?;
    let mut fingerprints=BTreeSet::new();
    for path in others {let other=preview_database(&path).await?;if other.product_count>0{fingerprints.insert(source_scope_key(&other));}}
    if fingerprints.len()>1{return Err("Existing POS databases differ by product identity, quantities, recorded branch scope, or tax metadata. No source was chosen automatically; review the exact database differences before import".into())}
    let (source_backup,source_backup_sha)=backup_source(&app,&source).await?;
    let dest_backup=recovery_export::verify_backup(&recovery_export::backup_root(&app)?,&backup_id).await?;
    let dest=initialization::app_database(&app)?;let mut db=initialization::connect(&dest).await?;
    let mut tx=db.begin_with("BEGIN IMMEDIATE").await.map_err(|_|"Database busy; inventory import was not committed")?;
    state_store::require_admin(&mut tx,&actor).await?;
    let old=state_store::read_state(&mut tx).await?.ok_or("Destination POS state missing")?;
    let manifest:Value=serde_json::from_slice(&std::fs::read(Path::new(&dest_backup.directory).join("manifest.json")).map_err(|_|"Destination backup manifest missing")?).map_err(|_|"Invalid destination backup manifest")?;
    if manifest["legacyStorage"].is_null(){return Err("Backup does not contain the current WebView recovery keys; export a fresh verified backup".into())}
    let new=import_state(&old,&association,&dest_backup,&confirmation,&source,&cloud_products,cloud_allow_negative_stock)?;
    if new!=old {
        let proof=new["inventoryActivation"].clone();
        if proof["sourceDatabaseSHA256"]!=source.sha256||proof["sourceFingerprint"]!=source.fingerprint||file_sha(&source_backup)?!=source_backup_sha{return Err("Verified source backup differs from the reviewed preview; no import was committed".into())}
        let affected=sqlx::query("UPDATE pos_state SET revision=?,document=? WHERE id=1 AND revision=?").bind(new["revision"].as_i64()).bind(new.to_string()).bind(old["revision"].as_i64()).execute(&mut *tx).await.map_err(|_|"Inventory import failed; transaction rolled back")?.rows_affected();
        if affected!=1{return Err("Destination changed during import; no import was committed".into())}
    }
    tx.commit().await.map_err(|_|"Inventory import acknowledgement was lost; verify state before retrying")?;
    state_store::read_state(&mut db).await?.ok_or("Imported state could not be read back".into())
}

#[cfg(test)]
mod tests {
 use super::*;
 fn p()->LegacyProduct{LegacyProduct{id:"legacy-1".into(),barcode:"201".into(),name:"Coffee".into(),stock_quantity:8,purchase_price:1.0,sale_price:2.0,is_active:true}}
 fn state()->Value{json!({"version":2,"revision":4,"association":{"businessId":"biz","branchId":"manar","ownerUserId":"owner","businessName":"Daily Supermarket","branchName":"manar"},"branches":{"unassigned":{"products":[],"entries":[],"sales":(0..22220).map(|i|json!({"id":format!("h{i}")})).collect::<Vec<_>>(),"refunds":[{"id":"old-refund"}],"heldSales":[],"completed":{},"exchangeRate":89500,"allowNegativeStock":true},"biz/manar":{"products":[],"entries":[],"sales":[],"refunds":[],"heldSales":[],"completed":{},"exchangeRate":89500,"allowNegativeStock":true,"productAliases":{}}},"outbox":[{"operationId":"receipt-old","payload":"retained"},{"operationId":"sale-old","payload":"retained"}],"pendingRequests":{},"inventoryActivation":null,"legacyBranchRecovery":null,"recovery":[],"project1Settings":{},"legacyStorageArchive":{}})}
 fn preview()->LegacyInventoryPreview{let products=vec![p()];let fingerprint=sha(&serde_json::to_vec(&products).unwrap());LegacyInventoryPreview{source_id:"source".into(),source_path:"source.db".into(),database_name:"pos.db".into(),sha256:"a".repeat(64),fingerprint,integrity:"ok".into(),product_count:1,active_product_count:1,stock_quantity_sum:8,sales_count:22220,refunds_count:1,inventory_entry_count:4,branch_assignments:vec!["unassigned".into()],tax_columns:vec![],products}}
 fn receipt(state:&Value)->recovery_export::BackupReceipt{recovery_export::BackupReceipt{id:"backup-1".into(),directory:"dir".into(),database:"dir/pos_v2.db".into(),sha256:"b".repeat(64),state_sha256:sha(state.to_string().as_bytes()),state_revision:state["revision"].as_i64().unwrap()}}
 fn assoc()->Value{state()["association"].clone()}
 fn cloud()->Value{json!([{"id":"legacy-1","barcode":"201","name":"Coffee","stockQuantity":8,"purchasePrice":1.0,"salePrice":2.0,"isActive":true}])}
 fn products_243()->Vec<LegacyProduct>{(0..243).map(|i|LegacyProduct{id:format!("legacy-{i}"),barcode:format!("{i:04}"),name:format!("Product {i}"),stock_quantity:(i%31) as i64,purchase_price:i as f64+0.25,sale_price:i as f64+1.5,is_active:true}).collect()}
 fn source_for(products:Vec<LegacyProduct>)->LegacyInventoryPreview{let fingerprint=sha(&serde_json::to_vec(&products).unwrap());LegacyInventoryPreview{source_id:"source-243".into(),source_path:"legacy.db".into(),database_name:"pos.db".into(),sha256:"c".repeat(64),fingerprint,integrity:"ok".into(),product_count:products.len(),active_product_count:products.len(),stock_quantity_sum:products.iter().map(|p|p.stock_quantity).sum(),sales_count:22220,refunds_count:0,inventory_entry_count:0,branch_assignments:vec!["unassigned (source schema has no branch column)".into()],tax_columns:vec![],products}}
 async fn make_legacy_db(path:&Path,products:&[LegacyProduct]){let mut db=SqliteConnection::connect_with(&SqliteConnectOptions::new().filename(path).create_if_missing(true)).await.unwrap();sqlx::query("CREATE TABLE products(id TEXT PRIMARY KEY, barcode TEXT NOT NULL, name TEXT NOT NULL, stockQuantity INTEGER NOT NULL, purchasePrice REAL NOT NULL, salePrice REAL NOT NULL, isActive INTEGER NOT NULL)").execute(&mut db).await.unwrap();for p in products{sqlx::query("INSERT INTO products VALUES(?,?,?,?,?,?,?)").bind(&p.id).bind(&p.barcode).bind(&p.name).bind(p.stock_quantity).bind(p.purchase_price).bind(p.sale_price).bind(p.is_active as i64).execute(&mut db).await.unwrap();}db.close().await.unwrap();}
 async fn make_durable_legacy_db(path:&Path,products:&[LegacyProduct]){let mut db=initialization::connect(path).await.unwrap();sqlx::query(include_str!("../migrations/003_durable_state.sql")).execute(&mut db).await.unwrap();let mut document=state();document["revision"]=json!(0);document["branches"]["unassigned"]["products"]=serde_json::to_value(products).unwrap();assert!(state_store::compare_and_swap(&mut db,-1,&document).await.unwrap());db.close().await.unwrap();}
 #[test] fn inventory_import_excludes_22220_sales_refunds_and_historical_queue_and_is_idempotent(){let old=state();let v=preview();let backup=receipt(&old);let first=import_state(&old,&assoc(),&backup,"Daily Supermarket / manar",&v,&cloud(),false).unwrap();assert_eq!(first["branches"]["biz/manar"]["products"].as_array().unwrap().len(),1);assert_eq!(first["branches"]["biz/manar"]["products"][0]["stockQuantity"],8);assert_eq!(first["branches"]["unassigned"]["sales"].as_array().unwrap().len(),22220);assert_eq!(first["branches"]["unassigned"]["refunds"],old["branches"]["unassigned"]["refunds"]);assert_eq!(first["outbox"],old["outbox"]);assert_eq!(import_state(&first,&assoc(),&backup,"Daily Supermarket / manar",&v,&cloud(),false).unwrap(),first);}
 #[test] fn rejects_cloud_or_destination_mismatch_without_mutation(){let old=state();let mut changed=cloud();changed[0]["stockQuantity"]=json!(9);let backup=receipt(&old);assert!(import_state(&old,&assoc(),&backup,"Daily Supermarket / manar",&preview(),&changed,false).unwrap_err().contains("differ"));let mut occupied=old.clone();occupied["branches"]["biz/manar"]["products"]=json!([{"id":"other"}]);let backup=receipt(&occupied);assert!(import_state(&occupied,&assoc(),&backup,"Daily Supermarket / manar",&preview(),&cloud(),false).is_err());assert_eq!(old["branches"]["unassigned"]["sales"].as_array().unwrap().len(),22220);}
 #[test] fn source_branch_ownership_and_existing_activation_cannot_be_switched(){let old=state();let backup=receipt(&old);let mut conflicting=preview();conflicting.branch_assignments=vec!["other-business/other-branch".into()];assert!(import_state(&old,&assoc(),&backup,"Daily Supermarket / manar",&conflicting,&cloud(),false).unwrap_err().contains("assignment"));let mut activated=old.clone();activated["inventoryActivation"]=json!({"sourceFingerprint":preview().fingerprint,"businessId":"biz","branchId":"manar","inventoryImport":true});let backup=receipt(&activated);assert!(import_state(&activated,&assoc(),&backup,"Daily Supermarket / manar",&preview(),&cloud(),false).is_ok());let other=json!({"businessId":"biz","branchId":"palma","ownerUserId":"owner","businessName":"Daily Supermarket","branchName":"palma"});assert!(import_state(&activated,&other,&backup,"Daily Supermarket / palma",&preview(),&cloud(),false).is_err());}
 #[test] fn unsupported_tax_metadata_is_preserved_in_preview_and_blocks_import(){let old=state();let backup=receipt(&old);let mut source=preview();source.tax_columns=vec!["products.tax_rate".into()];let error=import_state(&old,&assoc(),&backup,"Daily Supermarket / manar",&source,&cloud(),false).unwrap_err();assert!(error.contains("tax fields"));assert_eq!(old["branches"]["unassigned"]["sales"].as_array().unwrap().len(),22220);}
 #[test] fn matching_destination_is_idempotent_and_confirmation_is_required(){let old=state();let backup=receipt(&old);assert!(import_state(&old,&assoc(),&backup,"wrong",&preview(),&cloud(),false).is_err());let mut existing=old.clone();existing["branches"]["biz/manar"]["products"]=json!([{"id":"legacy-1","barcode":"201","name":"Coffee","stockQuantity":8,"purchasePrice":1.0,"salePrice":2.0,"isActive":true}]);let backup=receipt(&existing);let imported=import_state(&existing,&assoc(),&backup,"Daily Supermarket / manar",&preview(),&cloud(),false).unwrap();assert_eq!(imported["branches"]["biz/manar"]["products"].as_array().unwrap().len(),1);}
 #[test] fn two_hundred_forty_three_product_import_keeps_all_unassigned_history_and_stock_exact(){let mut src=source_for(products_243());src.stock_quantity_sum=src.products.iter().map(|p|p.stock_quantity).sum();let source_rows=Value::Array(canonical_products(&src.products).unwrap());let mut old=state();old["revision"]=json!(7);let backup=receipt(&old);let imported=import_state(&old,&assoc(),&backup,"Daily Supermarket / manar",&src,&source_rows,false).unwrap();assert_eq!(imported["branches"]["biz/manar"]["products"].as_array().unwrap().len(),243);assert_eq!(imported["branches"]["biz/manar"]["products"][0]["stockQuantity"],src.products.iter().find(|p|p.id=="legacy-0").unwrap().stock_quantity);assert_eq!(imported["branches"]["unassigned"]["sales"].as_array().unwrap().len(),22220);assert_eq!(imported["outbox"],old["outbox"]);assert_eq!(imported["branches"]["biz/manar"]["entries"],json!([]));}
 #[test] fn identifies_legacy_pos_db_and_current_pos_v2_state_by_schema_and_data(){tauri::async_runtime::block_on(async{let stamp=SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();let dir=std::env::temp_dir().join(format!("swift-till-legacy-db-{}-{stamp}",std::process::id()));std::fs::create_dir_all(&dir).unwrap();let products=products_243();let old=dir.join("pos.db");let current=dir.join("pos_v2.db");make_legacy_db(&old,&products).await;make_durable_legacy_db(&current,&products).await;let legacy=preview_database(&old).await.unwrap();let durable=preview_database(&current).await.unwrap();for found in [&legacy,&durable]{assert_eq!(found.product_count,243);assert_eq!(found.stock_quantity_sum,products.iter().map(|p|p.stock_quantity).sum::<i64>());}assert_eq!(legacy.fingerprint,durable.fingerprint);assert_eq!(legacy.branch_assignments,vec!["unassigned (source schema has no branch column)"]);assert_eq!(durable.branch_assignments,vec!["unassigned"]);assert_eq!(durable.sales_count,22220);std::fs::remove_dir_all(dir).unwrap();});}
 #[test] fn different_existing_inventory_sources_are_not_silently_selected(){let a=source_for(products_243());let mut products=products_243();products[0].stock_quantity+=1;let b=source_for(products);assert_ne!(a.fingerprint,b.fingerprint);}
 #[test] fn identical_stock_with_different_recorded_branch_scope_is_still_a_source_conflict(){let a=source_for(products_243());let mut b=a.clone();b.branch_assignments=vec!["business/palma".into()];assert_eq!(a.fingerprint,b.fingerprint);assert_ne!(source_scope_key(&a),source_scope_key(&b));}
 #[test] fn ownership_check_uses_business_and_branch_not_branch_name_alone(){let mut source=source_for(vec![p()]);source.branch_assignments=vec!["other-business/manar".into()];assert!(source_scope_conflicts(&source,"biz","manar"));source.branch_assignments=vec!["biz/manar".into()];assert!(!source_scope_conflicts(&source,"biz","manar"));source.branch_assignments=vec!["manar".into()];assert!(!source_scope_conflicts(&source,"biz","manar"));}
 #[test] fn imported_inventory_survives_sqlite_reopen_without_legacy_history_or_queue_changes(){tauri::async_runtime::block_on(async{let stamp=SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();let dir=std::env::temp_dir().join(format!("swift-till-import-reopen-{}-{stamp}",std::process::id()));std::fs::create_dir_all(&dir).unwrap();let path=dir.join("pos_v2.db");let mut db=initialization::connect(&path).await.unwrap();sqlx::query(include_str!("../migrations/003_durable_state.sql")).execute(&mut db).await.unwrap();let mut before=state();before["revision"]=json!(0);assert!(state_store::compare_and_swap(&mut db,-1,&before).await.unwrap());let src=source_for(products_243());let rows=Value::Array(canonical_products(&src.products).unwrap());let backup=receipt(&before);let after=import_state(&before,&assoc(),&backup,"Daily Supermarket / manar",&src,&rows,false).unwrap();assert!(state_store::compare_and_swap(&mut db,0,&after).await.unwrap());db.close().await.unwrap();let mut reopened=SqliteConnection::connect_with(&SqliteConnectOptions::new().filename(&path).read_only(true)).await.unwrap();let saved=state_store::read_state(&mut reopened).await.unwrap().unwrap();assert_eq!(saved["branches"]["biz/manar"]["products"].as_array().unwrap().len(),243);assert_eq!(saved["branches"]["unassigned"]["sales"].as_array().unwrap().len(),22220);assert_eq!(saved["branches"]["unassigned"]["refunds"].as_array().unwrap().len(),1);assert_eq!(saved["outbox"],before["outbox"]);assert_eq!(sqlx::query_scalar::<_,String>("PRAGMA integrity_check").fetch_one(&mut reopened).await.unwrap(),"ok");reopened.close().await.unwrap();std::fs::remove_dir_all(dir).unwrap();});}
}
