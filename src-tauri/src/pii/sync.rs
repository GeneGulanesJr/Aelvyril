use crate::state::SharedState;

/// Rebuild the shared PII engine from the current allow/deny list rules.
/// Called after any list mutation so the gateway's hot path picks up changes.
pub async fn sync_pii_engine(state: &SharedState) {
    let (allow_rules, deny_rules) = {
        let s = state.read().await;
        (s.list_manager.list_allow(), s.list_manager.list_deny())
    };

    let mut fresh = crate::pii::PiiEngine::new();
    for rule in allow_rules {
        if rule.enabled {
            let _ = fresh.add_allow_pattern(&rule.pattern);
        }
    }
    for rule in deny_rules {
        if rule.enabled {
            let _ = fresh.add_deny_pattern(&rule.pattern);
        }
    }

    let s = state.read().await;
    *s.pii_engine.write().await = fresh;
}

