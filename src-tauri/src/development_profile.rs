//! Standalone debug-only fixture preparation. No IPC command or release code.
use std::path::{Path, PathBuf};
use sqlx::{Connection, Row, SqliteConnection};
use crate::initialization::{connect, hash_password, initialize, LegacyData};

const MARKER:&str=".swift-till-disposable-development-profile";
const FORMAT:&str="Swift Till disposable development profile v1";
const FIXTURE_KEY:&str="disposable_development_admin_id";

pub fn validate_profile(path:&Path) -> Result<PathBuf,String> {
    let path=path.canonicalize().map_err(|_|"Development profile does not exist")?;
    let temp=std::env::temp_dir().canonicalize().map_err(|_|"Temporary directory unavailable")?;
    if path.parent()!=Some(temp.as_path()) || !path.file_name().is_some_and(|name|name.to_string_lossy().starts_with("swift-till-dev-")) || std::fs::read_to_string(path.join(MARKER)).ok().as_deref()!=Some(FORMAT) {
        return Err("Development accounts require a marked disposable directory directly under OS temp".into());
    }
    Ok(path)
}

pub fn create_profile() -> Result<PathBuf,String> {
    use rand_core::RngCore;
    let path=std::env::temp_dir().join(format!("swift-till-dev-{:016x}",rand_core::OsRng.next_u64()));
    std::fs::create_dir(&path).map_err(|_|"Cannot create new disposable profile")?;
    std::fs::write(path.join(MARKER),FORMAT).map_err(|_|"Cannot mark disposable profile")?;
    validate_profile(&path)
}

pub async fn seed_administrator(path:&Path) -> Result<String,String> {
    let path=validate_profile(path)?;
    let database=path.join("pos_v2.db");
    // Do not follow a database link out of the isolated directory.
    if database.exists() && database.canonicalize().map_err(|_|"Invalid fixture database")?.parent()!=Some(path.as_path()) {return Err("Linked fixture database refused".into());}
    let mut conn=connect(&database).await?;
    let legacy:LegacyData=serde_json::from_value(serde_json::json!({"alreadyMigrated":true})).map_err(|_|"Invalid fixture initializer")?;
    initialize(&mut conn,&legacy).await?;
    let hash=hash_password("admin123456")?;
    let mut tx=conn.begin_with("BEGIN IMMEDIATE").await.map_err(|_|"Fixture database busy")?;
    let rows=sqlx::query("SELECT id FROM users WHERE lower(username)='admin'").fetch_all(&mut *tx).await.map_err(|_|"Cannot inspect fixture administrator")?;
    if rows.len()>1 {return Err("Ambiguous fixture administrators; no reset performed".into());}
    let id=if let Some(row)=rows.first() {
        let id:String=row.get("id");
        sqlx::query("UPDATE users SET password=?,role='admin' WHERE id=?").bind(&hash).bind(&id).execute(&mut *tx).await.map_err(|_|"Cannot update fixture account")?;
        id
    } else {
        let id="disposable-development-admin".to_string();
        sqlx::query("INSERT INTO users(id,username,password,role,name) VALUES(?,'admin',?,'admin','Development Administrator')").bind(&id).bind(&hash).execute(&mut *tx).await.map_err(|_|"Cannot seed fixture account")?;
        id
    };
    for (key,value) in [(FIXTURE_KEY.to_string(),id.clone()),("first_admin_created".to_string(),"true".to_string()),(format!("password_rotation:{id}"),"false".to_string())] {
        sqlx::query("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(key).bind(value).execute(&mut *tx).await.map_err(|_|"Cannot record fixture state")?;
    }
    tx.commit().await.map_err(|_|"Cannot commit fixture account")?;
    Ok(id)
}

pub(crate) async fn is_seeded_account(conn:&mut SqliteConnection,id:&str) -> Result<bool,String> {
    let rows=sqlx::query("PRAGMA database_list").fetch_all(&mut *conn).await.map_err(|_|"Cannot verify local database scope")?;
    let Some(row)=rows.iter().find(|row|row.get::<String,_>("name")=="main") else {return Ok(false)};
    let file: String=row.get("file");
    let Some(parent)=Path::new(&file).parent() else {return Ok(false)};
    if validate_profile(parent).is_err() {return Ok(false)}
    let fixture:Option<String>=sqlx::query_scalar("SELECT value FROM settings WHERE key=?").bind(FIXTURE_KEY).fetch_optional(conn).await.map_err(|_|"Cannot inspect fixture marker")?;
    Ok(fixture.as_deref()==Some(id))
}
