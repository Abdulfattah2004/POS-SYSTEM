use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let qa_profile=initialization::qa_profile().expect("Invalid disposable QA profile");
    let dev_profile=initialization::development_profile().expect("Invalid disposable development profile");
    let native_smoke=qa_profile.is_some();
    if let Some(profile)=qa_profile.as_ref() { record_qa_startup(profile,"profile_validated"); }
    if native_smoke && tauri::is_dev() {
        let profile=qa_profile.as_ref().unwrap();
        record_qa_startup(profile,"development_frontend_build_rejected");
        let _=std::fs::write(profile.join("native-smoke.json"),r#"{"error":"Native QA requires bundled frontend assets; use npm.cmd run build:native-qa","stage":"build_mode","bundled_frontend":false}"#);
        std::process::exit(1); // Only this validated disposable QA process exits.
    }
    let isolated_profile=qa_profile.or(dev_profile);
    let mut context=tauri::generate_context!();
    if native_smoke { record_qa_startup(isolated_profile.as_ref().unwrap(),"context_generated"); }
    if isolated_profile.is_some() {
        // No customer WebView is ever opened by the disposable native smoke.
        for window in &mut context.config_mut().app.windows { window.create=false; }
    }
    tauri::Builder::default()
        .manage(state_store::NativeSession::default())
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations(
                    "sqlite:pos_v2.db",
                    vec![
                        tauri_plugin_sql::Migration {
                            version: 1,
                            description: "create POS tables",
                            sql: include_str!("../migrations/001_create_pos_tables.sql"),
                            kind: tauri_plugin_sql::MigrationKind::Up,
                        },
                        tauri_plugin_sql::Migration {
                            version: 2,
                            description: "add indexes for faster reports",
                            sql: include_str!("../migrations/002_add_indexes.sql"),
                            kind: tauri_plugin_sql::MigrationKind::Up,
                        },
                    ],
                )
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            initialization::initialize_database,
            initialization::create_first_admin,
            initialization::login_local,
            state_store::read_pos_state,
            state_store::read_original_snapshot,
            state_store::commit_pos_state,
            state_store::list_local_users,
            state_store::add_local_user,
            state_store::remove_local_user,
            state_store::logout_local,
            state_store::change_local_password,
            recovery_export::export_sqlite_recovery,
            recovery_export::recover_legacy_branch,
            recovery_export::activate_verified_inventory,
            legacy_inventory::discover_legacy_inventory,
            legacy_inventory::import_legacy_inventory,
            record_qa_storage,
        ])
        .setup(move |app| {
            if let Some(profile)=isolated_profile {
                if native_smoke { record_qa_startup(&profile,"setup_entered"); }
                let config=app.config().app.windows.first().ok_or("Missing QA window configuration")?;
                if native_smoke { record_qa_startup(&profile,"webview_build_start"); }
                tauri::WebviewWindowBuilder::from_config(app.handle(),config)?
                    .initialization_script(r#"(() => {
                      // This branch runs ONLY in a validated, marked disposable
                      // QA profile. Copied sessions can never contact production.
                      const local = (url) => {
                        try {
                          const raw = url instanceof URL ? url.href : typeof url === 'string' ? url : url?.url;
                          if(typeof raw !== 'string') return false;
                          const u = new URL(raw, location.href);
                          return !['http:','https:','ws:','wss:'].includes(u.protocol) || ['ipc.localhost','tauri.localhost','localhost','127.0.0.1','[::1]'].includes(u.hostname);
                        } catch { return false; }
                      };
                      const fetchOriginal = window.fetch.bind(window);
                      window.fetch = (input, init) => local(input) ? fetchOriginal(input, init) : Promise.reject(new Error('Remote requests disabled in disposable native QA'));
                      const openOriginal = XMLHttpRequest.prototype.open;
                      XMLHttpRequest.prototype.open = function(method, url, ...rest) { if(!local(url)) throw new Error('Remote requests disabled in disposable native QA'); return openOriginal.call(this, method, url, ...rest); };
                      for(const name of ['WebSocket','EventSource']) {
                        const original = window[name];
                        if(original) window[name] = new Proxy(original, { construct(target, args) { if(!local(args[0])) throw new Error('Remote requests disabled in disposable native QA'); return Reflect.construct(target, args); } });
                      }
                      window.__swiftTillCaptureStorage = async (phase) => {
                        const pairs = Array.from({length: localStorage.length}, (_, i) => { const key=localStorage.key(i);return [key,localStorage.getItem(key)]; });
                        const values = Object.fromEntries(await Promise.all(pairs.map(async ([key,value]) => {
                          const hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value));
                          return [key,Array.from(new Uint8Array(hash),byte=>byte.toString(16).padStart(2,'0')).join('')];
                        })));
                        await window.__TAURI_INTERNALS__.invoke('record_qa_storage',{phase,values});
                      };
                      void window.__swiftTillCaptureStorage('before').catch(()=>{});
                    })();"#)
                    .data_directory(profile.join("webview")).visible(!native_smoke)
                    .title(if native_smoke {config.title.clone()} else {"Swift Till - DISPOSABLE DEVELOPMENT PROFILE".into()}).build()?;
                if native_smoke {
                record_qa_startup(&profile,"webview_build_complete");
                let handle=app.handle().clone();
                std::thread::spawn(move || {
                    record_qa_startup(&profile,"watchdog_started");
                    std::thread::sleep(std::time::Duration::from_secs(17));
                    if let Some(window)=handle.get_webview_window("main") {
                        let _=window.eval("void window.__swiftTillCaptureStorage('after').catch(()=>{});");
                    }
                    std::thread::sleep(std::time::Duration::from_secs(3));
                    let mut report=tauri::async_runtime::block_on(native_qa::inspect(&profile));
                    report["bundled_frontend"]=serde_json::json!(!tauri::is_dev());
                    record_qa_startup(&profile,"database_check_complete");
                    let _=std::fs::write(profile.join("native-smoke.json"),report.to_string());
                    handle.exit(0); // Only this disposable QA process exits.
                });
                }
            }
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            Ok(())
        })
        .run(context)
        .expect("error while running tauri application");
}
mod initialization;
#[cfg(debug_assertions)]
pub mod development_profile;
mod state_store;
mod connection_safety;
mod transition_guard;
mod recovery_export;
mod legacy_inventory;
mod native_qa;
#[cfg(test)]
mod upgrade_tests;
#[cfg(test)]
mod auth_boundary_tests;
#[cfg(test)]
mod pending_request_tests;

// Diagnostics contain only fixed stage names and write only beneath an already
// validated disposable QA profile. Never record credentials or customer data.
fn record_qa_startup(profile: &std::path::Path, stage: &str) {
    use std::io::Write;
    if let Ok(mut file)=std::fs::OpenOptions::new().create(true).append(true).open(profile.join("native-startup-stages.log")) {
        let _=writeln!(file,"{stage}");
    }
}

// Only the marked disposable QA process can record hash metadata. Customer
// processes cannot enable this through IPC; no raw storage values are written.
#[tauri::command]
fn record_qa_storage(phase:String,values:std::collections::BTreeMap<String,String>) -> Result<(),String> {
    let profile=initialization::qa_profile()?.ok_or("Storage audit is available only in a disposable QA process")?;
    if !["before","after"].contains(&phase.as_str()) || values.len()>1000 || values.iter().any(|(key,hash)|key.len()>512 || hash.len()!=64 || !hash.bytes().all(|byte|byte.is_ascii_hexdigit())) {
        return Err("Invalid QA storage hash metadata".into());
    }
    let path=profile.join(format!("qa-storage-{phase}.json"));
    std::fs::write(path,serde_json::to_vec(&values).map_err(|_|"Cannot encode QA storage hashes")?).map_err(|_|"Cannot record QA storage hashes".to_string())?;
    record_qa_startup(&profile,if phase=="before" {"javascript_ipc_before"} else {"javascript_ipc_after"});
    Ok(())
}
