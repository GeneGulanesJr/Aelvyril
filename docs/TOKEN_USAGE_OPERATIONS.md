# Token Usage Operations Runbook

**Document version:** 1.0
**Last updated:** 2026-04-23
**Owner:** Engineering / SRE

---

## 1. Dogfooding Token Usage Stats

### Daily Dashboard Check

Every engineer should review the token usage dashboard once per day:

1. Open the Aelvyril stats panel (Settings → Token Usage)
2. Check the 24h summary for anomalies:
   - Unusually high cost (>3× typical daily spend)
   - High truncation rate (>5% of calls)
   - Low success rate (<95%)
   - High retry rate (>10%)

### Weekly Review Checklist

| Metric | Healthy Range | Action if Unhealthy |
|--------|--------------|---------------------|
| Avg cost per task | <$0.05 | Investigate expensive tools or models |
| Truncation rate | <2% | Review context window management |
| Retry rate | <5% | Check provider stability or timeout config |
| Orphan rate | <1% | Review session lifecycle management |
| Success rate | >95% | Investigate error patterns |

### Monthly Cost Review

1. Export monthly stats JSON via admin API
2. Compare against budget target
3. Identify top-3 cost drivers by tool and model
4. File optimization tickets for outliers

---

## 2. Monitoring Orphan Sessions

### What is an Orphan?

A session becomes orphaned when:
- No events have been recorded for >30 minutes (configurable via `ORPHAN_SESSION_TIMEOUT_MINUTES`)
- The session was never explicitly closed

Orphaned sessions are auto-closed by `auto_close_orphaned_sessions()`.

### Monitoring

```bash
# Check orphan count
curl -s http://localhost:3000/token-stats/global | jq '.meta.orphaned'

# Check active session count
curl -s http://localhost:3000/token-stats/global | jq '.global_summary.active_sessions'
```

### Alert Thresholds

| Condition | Severity | Action |
|-----------|----------|--------|
| Orphan rate >5% of active sessions | Warning | Review client disconnect handling |
| Orphan rate >20% of active sessions | Critical | Check for client crash loop |
| Active sessions >1000 | Warning | Potential memory pressure |

### Remediation

1. Check client logs for unhandled disconnects
2. Verify `close_session()` is called on app exit
3. If persistent, increase `ORPHAN_SESSION_TIMEOUT_MINUTES` temporarily
4. Clear orphaned sessions via admin API if needed

---

## 3. Cost Alert Thresholds

### Built-in Alerts

The `CostAlertChecker` evaluates every session for these conditions:

| Alert | Threshold | Severity |
|-------|-----------|----------|
| Cost spike | >3× daily average | Warning |
| High session cost | >$10 in one session | Warning |
| High retry rate | >20% retry rate | Warning |
| Runaway tokens | >1M tokens in one session | Critical |
| Budget exhaustion | >80% of monthly budget | Warning |

### Configuring Thresholds

Edit `src-tauri/src/token_usage/alerts.rs`:

```rust
const COST_SPIKE_MULTIPLIER: f64 = 3.0;      // Change to 2.0 for tighter monitoring
const HIGH_COST_SESSION_CENTS: u64 = 1000;   // $10 → change to 500 for $5 threshold
const HIGH_RETRY_RATE_PCT: f64 = 20.0;       // Change to 10.0 for stricter alerting
```

### Custom Alerts

Add custom alert rules by implementing the `CostAlert` trait:

```rust
impl CostAlert for MyCustomAlert {
    fn check(&self, stats: &SessionTokenStats) -> Option<Alert> {
        // Your logic here
    }
}
```

Register in `CostAlertChecker::new()`.

### Responding to Alerts

1. **Cost spike:** Check if a new feature or model was deployed. Review the tool breakdown to identify the culprit.
2. **High session cost:** Investigate the session for runaway loops (e.g., retry storms).
3. **High retry rate:** Check provider status page. Increase timeout or switch model temporarily.
4. **Runaway tokens:** Immediately investigate for infinite loops or unbounded context growth.

---

## 4. Tuning Suggestion Quality

### Current Suggestion Logic

Suggestions are generated in `build_suggestion()` based on:

- Truncation rate >5% → "Reduce context size..."
- System overhead >30% → "System prompt is large..."
- Tokens saved >10% → "Good token efficiency..."

### Improving Suggestions

1. **Add model-specific suggestions:**
   - "Consider switching to gpt-4o-mini for this task (estimated 60% cost reduction)"

2. **Add time-of-day suggestions:**
   - "Peak hours detected — consider queuing non-urgent tasks"

3. **Add comparison suggestions:**
   - "Your avg cost/task is 2× higher than team median"

4. **Tune thresholds:**
   - Lower truncation threshold from 5% to 2% for stricter warnings
   - Add success rate suggestions (<90% → "High failure rate — check error logs")

### Measuring Suggestion Quality

Track suggestion effectiveness:
- Did the user act on the suggestion? (click-through rate)
- Did the metric improve after the suggestion? (before/after comparison)
- Is the suggestion rate too high? (alert fatigue)

Target: <3 suggestions per day per user, >20% action rate.

---

## 5. Operational Commands

### Check System Health

```bash
# Verify SQLite store connectivity
cargo test test_tracker_with_store_wiring -- --nocapture

# Verify orphan detection
cargo test test_orphan_session_detection -- --nocapture

# Verify alert thresholds
cargo test test_cost_alert_thresholds -- --nocapture
```

### Manual Maintenance

```bash
# Purge old events (default: 30 days)
curl -X POST http://localhost:3000/admin/token-stats/purge?days=30

# Export session data
curl -s http://localhost:3000/token-stats/session/{session_id}/export > session_export.json

# Delete session data
curl -X DELETE http://localhost:3000/admin/token-stats/session/{session_id}
```

### Performance Monitoring

```bash
# Benchmark event recording
cargo test test_record_performance_under_load -- --nocapture

# Typical throughput: >10,000 events/sec on modern hardware
```

---

## 6. Incident Response

### Token Stats API Down

1. Check if SQLite file is accessible (`ls -la data/token_usage.db`)
2. Check disk space (`df -h`)
3. If corrupted, restore from backup or delete and reinitialize
4. Events recorded during downtime are lost (in-memory buffer is not persisted)

### Cost Alert Storm

1. Identify the root cause (new deployment, model change, provider issue)
2. Temporarily disable alerts if needed: comment out alert checker in tracker
3. Fix root cause
4. Re-enable alerts

### Data Leak Suspected

1. Immediately check `access_level` in recent API responses
2. Review audit logs for unauthorized access
3. Verify tenant isolation: `test_no_cross_tenant_leakage`
4. If confirmed, follow incident response playbook
