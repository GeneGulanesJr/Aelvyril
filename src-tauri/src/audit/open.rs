use crate::audit::store::AuditStore;

pub fn open_audit_db() -> Option<AuditStore> {
    // Store the audit DB next to the app data
    let db_path = dirs::data_local_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join("aelvyril")
        .join("audit.db");

    // Ensure directory exists
    if let Some(parent) = db_path.parent() {
        if let Err(e) = std::fs::create_dir_all(parent) {
            tracing::warn!("Failed to create audit DB directory: {}", e);
        }
    }

    match AuditStore::open(&db_path) {
        Ok(store) => {
            tracing::info!("📝 Audit database opened at {:?}", db_path);
            Some(store)
        }
        Err(e) => {
            tracing::warn!("Failed to open audit database: {}", e);
            None
        }
    }
}

