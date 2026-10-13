#[test]
fn weak_legacy_admin_cannot_bypass_native_password_rotation() {
    tauri::async_runtime::block_on(async {
        use crate::initialization::{authenticate, connect, initialize, LegacyData};
        use crate::state_store::require_admin;
        use rand_core::RngCore;
        let directory = std::env::temp_dir().join(format!(
            "swift-till-auth-boundary-{}",
            rand_core::OsRng.next_u64()
        ));
        std::fs::create_dir_all(&directory).unwrap();
        let mut db = connect(&directory.join("pos_v2.db")).await.unwrap();
        let legacy:LegacyData=serde_json::from_value(serde_json::json!({"users":[{"id":"weak-admin","username":"weak","password":"admin123","role":"admin","name":"Synthetic admin"}]})).unwrap();
        initialize(&mut db, &legacy).await.unwrap();
        let user = authenticate(&mut db, "weak", "admin123")
            .await
            .unwrap()
            .unwrap();
        assert!(user.requires_password_change);
        assert!(require_admin(&mut db, "weak-admin")
            .await
            .unwrap_err()
            .contains("Change your existing account password"));
        let count: i64 = sqlx::query_scalar("SELECT count(*) FROM users")
            .fetch_one(&mut db)
            .await
            .unwrap();
        assert_eq!(count, 1);
    });
}

#[test]
#[cfg(debug_assertions)]
fn disposable_default_admin_is_hashed_upserted_and_survives_reopen() {
    tauri::async_runtime::block_on(async {
        use crate::{development_profile::{create_profile,seed_administrator},initialization::{authenticate,connect},state_store::require_admin};
        use sqlx::Connection;
        let profile=create_profile().unwrap();
        let id=seed_administrator(&profile).await.unwrap();
        let mut db=connect(&profile.join("pos_v2.db")).await.unwrap();
        sqlx::query("INSERT INTO settings(key,value) VALUES('keep-test-setting','keep')").execute(&mut db).await.unwrap();
        sqlx::query("INSERT INTO products(id,barcode,name,stockQuantity,purchasePrice,salePrice) VALUES('kept-product','fixture-code','Kept',7,1,2)").execute(&mut db).await.unwrap();
        sqlx::query("INSERT INTO users(id,username,password,role,name) VALUES('kept-cashier','cashier',?,'cashier','Kept cashier')").bind(crate::initialization::hash_password("synthetic-cashier-password").unwrap()).execute(&mut db).await.unwrap();
        let cashier_before:(String,String,String)=sqlx::query_as("SELECT id,password,role FROM users WHERE id='kept-cashier'").fetch_one(&mut db).await.unwrap();
        let hash:String=sqlx::query_scalar("SELECT password FROM users WHERE id=?").bind(&id).fetch_one(&mut db).await.unwrap();
        assert!(hash.starts_with("$argon2id$"));assert!(!hash.contains("admin123456"));
        assert!(authenticate(&mut db,"admin","wrong-password").await.unwrap().is_none());
        let user=authenticate(&mut db," ADMIN ","admin123456").await.unwrap().unwrap();
        assert_eq!(user.role,"admin");assert!(!user.requires_password_change);require_admin(&mut db,&id).await.unwrap();
        db.close().await.unwrap();
        assert_eq!(seed_administrator(&profile).await.unwrap(),id);
        let mut reopened=connect(&profile.join("pos_v2.db")).await.unwrap();
        assert_eq!(sqlx::query_scalar::<_,i64>("SELECT count(*) FROM users").fetch_one(&mut reopened).await.unwrap(),2);
        assert_eq!(sqlx::query_scalar::<_,i64>("SELECT count(*) FROM users WHERE lower(username)='admin'").fetch_one(&mut reopened).await.unwrap(),1);
        let cashier_after:(String,String,String)=sqlx::query_as("SELECT id,password,role FROM users WHERE id='kept-cashier'").fetch_one(&mut reopened).await.unwrap();assert_eq!(cashier_before,cashier_after);
        assert_eq!(sqlx::query_scalar::<_,i64>("SELECT stockQuantity FROM products WHERE id='kept-product'").fetch_one(&mut reopened).await.unwrap(),7);
        let refreshed:String=sqlx::query_scalar("SELECT password FROM users WHERE id=?").bind(&id).fetch_one(&mut reopened).await.unwrap();
        assert_ne!(hash,refreshed); // Unique salt on deliberate fixture reseed.
        assert_eq!(sqlx::query_scalar::<_,String>("SELECT value FROM settings WHERE key='keep-test-setting'").fetch_one(&mut reopened).await.unwrap(),"keep");
        assert_eq!(authenticate(&mut reopened,"admin","admin123456").await.unwrap().unwrap().id,id);
        assert_eq!(sqlx::query_scalar::<_,String>("PRAGMA integrity_check").fetch_one(&mut reopened).await.unwrap(),"ok");
    });
}

#[test]
fn ordinary_database_cannot_use_development_password_policy() {
    tauri::async_runtime::block_on(async {
        use crate::initialization::{connect,initialize,LegacyData,hash_password,authenticate};
        use rand_core::RngCore;
        let path=std::env::temp_dir().join(format!("swift-till-normal-auth-{}.db",rand_core::OsRng.next_u64()));
        let mut db=connect(&path).await.unwrap();initialize(&mut db,&LegacyData::default()).await.unwrap();
        sqlx::query("INSERT INTO users(id,username,password,role,name) VALUES('existing','admin',?,'admin','Original')").bind(hash_password("admin123456").unwrap()).execute(&mut db).await.unwrap();
        sqlx::query("INSERT INTO settings(key,value) VALUES('disposable_development_admin_id','existing')").execute(&mut db).await.unwrap();
        assert!(authenticate(&mut db,"admin","admin123456").await.unwrap().unwrap().requires_password_change);
        #[cfg(debug_assertions)]
        assert!(crate::development_profile::seed_administrator(path.parent().unwrap()).await.is_err());
        assert_eq!(sqlx::query_scalar::<_,i64>("SELECT count(*) FROM users").fetch_one(&mut db).await.unwrap(),1);
    });
}

#[test]
#[cfg(debug_assertions)]
fn ambiguous_case_insensitive_accounts_fail_closed_without_changes() {
    tauri::async_runtime::block_on(async {
        use crate::initialization::{connect,initialize,LegacyData,hash_password,authenticate};
        let profile=crate::development_profile::create_profile().unwrap();
        let mut db=connect(&profile.join("pos_v2.db")).await.unwrap();initialize(&mut db,&LegacyData::default()).await.unwrap();
        for (id,name) in [("one","Admin"),("two","admin")] {
            sqlx::query("INSERT INTO users(id,username,password,role,name) VALUES(?,?,?,'admin',?)").bind(id).bind(name).bind(hash_password("synthetic-strong-password").unwrap()).bind(name).execute(&mut db).await.unwrap();
        }
        let before:Vec<(String,String)>=sqlx::query_as("SELECT id,password FROM users ORDER BY id").fetch_all(&mut db).await.unwrap();
        assert!(authenticate(&mut db,"admin","synthetic-strong-password").await.unwrap_err().contains("Ambiguous"));
        assert!(crate::development_profile::seed_administrator(&profile).await.is_err());
        let after:Vec<(String,String)>=sqlx::query_as("SELECT id,password FROM users ORDER BY id").fetch_all(&mut db).await.unwrap();assert_eq!(before,after);
    });
}
