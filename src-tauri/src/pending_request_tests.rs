use serde_json::{json,Value};
use crate::state_store::validate_pending_requests;
fn state()->Value {json!({"version":2,"revision":0,"association":null,"branches":{"unassigned":{"products":[],"sales":[],"refunds":[],"entries":[],"completed":{}}},"outbox":[]})}
#[test]
fn request_envelopes_enforce_operator_scope_and_original_payload(){
    let old=state();let key="pos_checkout_v3:cashier:unassigned";
    let mut next=old.clone();next["pendingRequests"]=json!({key:{"id":"original-id","payload":{"quantity":2}}});
    validate_pending_requests(&old,&next,"cashier").unwrap();
    assert!(validate_pending_requests(&old,&next,"another-user").is_err());
    let mut scoped=old.clone();scoped["association"]=json!({"businessId":"business","branchId":"main"});
    assert!(validate_pending_requests(&scoped,&next,"cashier").is_err());
    let mut changed=next.clone();changed["pendingRequests"][key]["id"]=json!("new-id");
    assert!(validate_pending_requests(&next,&changed,"cashier").is_err());
    let mut removed=next.clone();removed["pendingRequests"]=json!({});assert!(validate_pending_requests(&next,&removed,"cashier").is_err());
    let mut completed=next.clone();completed["pendingRequests"][key]=Value::Null;validate_pending_requests(&next,&completed,"cashier").unwrap();
    let mut invalid=old.clone();invalid["pendingRequests"]=json!({key:{"id":"","payload":{}}});assert!(validate_pending_requests(&old,&invalid,"cashier").is_err());
}
#[test]
fn sqlite_wal_request_and_snapshot_survive_restart_preserving_original_history(){tauri::async_runtime::block_on(async {
    use crate::{initialization::{connect,initialize,LegacyData},state_store::{compare_and_swap,read_state},recovery_export::create_backup};
    use rand_core::RngCore;
    use sqlx::Connection;
    let folder=std::env::temp_dir().join(format!("swift-till-pending-{}",rand_core::OsRng.next_u64()));std::fs::create_dir_all(&folder).unwrap();
    let path=folder.join("pos_v2.db");let mut db=connect(&path).await.unwrap();initialize(&mut db,&LegacyData::default()).await.unwrap();
    sqlx::query("PRAGMA journal_mode=WAL").execute(&mut db).await.unwrap();
    let mut old=state();old["branches"]["unassigned"]["sales"]=json!((0..22220).map(|i|json!({"id":format!("original-{i}"),"legacy":true,"total":2,"items":[]})).collect::<Vec<_>>());
    assert!(compare_and_swap(&mut db,-1,&old).await.unwrap());
    let key="pos_checkout_v3:cashier:unassigned";let mut saved=old.clone();saved["revision"]=json!(1);saved["pendingRequests"]=json!({key:{"id":"original-checkout-id","payload":{"quantity":2}}});
    validate_pending_requests(&old,&saved,"cashier").unwrap();assert!(compare_and_swap(&mut db,0,&saved).await.unwrap());
    // A stale writer cannot replace the durable request or financial history.
    let mut stale=old.clone();stale["revision"]=json!(1);assert!(!compare_and_swap(&mut db,0,&stale).await.unwrap());
    let backup=create_backup(&path,&folder.join("exports"),std::collections::BTreeMap::new()).await.unwrap();
    db.close().await.unwrap();let mut reopened=connect(&path).await.unwrap();assert_eq!(read_state(&mut reopened).await.unwrap().unwrap(),saved);
    let mut copy=connect(std::path::Path::new(&backup.database)).await.unwrap();assert_eq!(read_state(&mut copy).await.unwrap().unwrap(),saved);
    let mut finished=saved.clone();finished["revision"]=json!(2);finished["pendingRequests"][key]=Value::Null;
    validate_pending_requests(&saved,&finished,"cashier").unwrap();assert!(compare_and_swap(&mut reopened,1,&finished).await.unwrap());
    let after=read_state(&mut reopened).await.unwrap().unwrap();assert_eq!(after["branches"],old["branches"]);assert_eq!(after["outbox"],old["outbox"]);
    assert_eq!(sqlx::query_scalar::<_,String>("PRAGMA integrity_check").fetch_one(&mut reopened).await.unwrap(),"ok");
});}
