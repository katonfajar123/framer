//! Framer — a quiet, local-first media gallery for Windows 11.
//!
//! The Rust core owns everything that touches the disk: indexing, thumbnails, the file
//! watcher and the SQLite library. The webview is a thin UI that talks to it through the
//! commands registered at the bottom of this file.

mod db;
mod disk;
mod error;
mod exif_info;
mod folders;
mod media;
mod paths;
mod scan;
mod search;
mod settings;
mod sources;
mod thumbs;
mod watch;

use db::Db;
use scan::ScanRegistry;
use std::{borrow::Cow, fs, path::Path};
use tauri::Manager;
use thumbs::Thumbs;
use watch::Watchers;

/// Scheme used by the UI to load thumbnails: `framer-thumb://localhost/<media id>`.
const THUMB_SCHEME: &str = "framer-thumb";

fn setup(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    // FRAMER_DATA_DIR supports portable setups. FRAME_DATA_DIR remains as a compatibility alias.
    let data_dir =
        match std::env::var_os("FRAMER_DATA_DIR").or_else(|| std::env::var_os("FRAME_DATA_DIR")) {
            Some(custom) => std::path::PathBuf::from(custom),
            None => app.path().app_data_dir()?,
        };
    let cache_dir = data_dir.join("thumbnails");
    fs::create_dir_all(&cache_dir)?;

    let db = Db::new(data_dir.join("frame.db"));
    db.migrate()?;
    let thumbs = Thumbs::new(cache_dir, db.clone());
    let registry = ScanRegistry::default();
    let watchers = Watchers::default();

    let handle = app.handle().clone();
    let watching = settings::get_bool(&db, "watchFolders");
    let scan_on_launch = settings::get_bool(&db, "scanOnLaunch");
    for source in sources::list_rows(&db)? {
        let root = Path::new(&source.path);
        if !root.is_dir() {
            continue; // an unplugged drive: keep its index, mark it unavailable
        }
        sources::allow_in_webview(&handle, root);
        if watching {
            let _ = watchers.attach(source.id, root);
        }
        if scan_on_launch {
            scan::spawn(handle.clone(), db.clone(), registry.clone(), source);
        }
    }
    watch::spawn_monitor(handle, db.clone(), registry.clone(), watchers.clone());

    let trim = thumbs.clone();
    tauri::async_runtime::spawn_blocking(move || trim.trim_to_limit());

    app.manage(db);
    app.manage(thumbs);
    app.manage(registry);
    app.manage(watchers);
    app.manage(disk::DiskScanner::default());
    Ok(())
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .register_asynchronous_uri_scheme_protocol(THUMB_SCHEME, |context, request, responder| {
            let app = context.app_handle().clone();
            let request_path = request.uri().path().to_owned();
            tauri::async_runtime::spawn_blocking(move || {
                let response = match app.try_state::<Thumbs>() {
                    Some(thumbs) => thumbs::respond(&thumbs, &request_path),
                    None => tauri::http::Response::builder()
                        .status(503)
                        .body(Vec::new())
                        .unwrap_or_default(),
                };
                responder.respond(response.map(Cow::from));
            });
        })
        .setup(setup)
        .invoke_handler(tauri::generate_handler![
            sources::list_sources,
            sources::add_source,
            sources::remove_source,
            sources::rescan_source,
            sources::rescan_all,
            sources::relink_source,
            sources::pause_scans,
            sources::resume_scans,
            sources::cancel_scans,
            sources::scan_state,
            media::list_media,
            media::library_layout,
            media::media_position,
            media::media_ids,
            media::get_media,
            media::media_exif,
            media::set_favorites,
            media::toggle_favorite,
            media::library_stats,
            media::reveal_in_explorer,
            media::trash_media,
            folders::folder_tree,
            settings::get_settings,
            settings::set_setting,
            thumbs::clear_thumbnail_cache,
            disk::list_disks,
            disk::analyze_disk,
            disk::cancel_disk_scan,
            disk::open_disk_path,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Framer");
}
