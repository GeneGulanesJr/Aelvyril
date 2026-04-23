# Token Usage Statistics — Regulatory & Compliance Guide

**Document version:** 1.0  
**Last updated:** 2026-04-23  
**Owner:** Engineering + Legal (review required)

---

## 1. GDPR Classification

### Is token usage data "personal data" under GDPR?

**Assessment:** Token usage statistics are **pseudonymous**, not directly personal. However, classification depends on how `session_id` is generated and whether it can be linked back to a natural person.

| Scenario | Classification | GDPR applies? |
|----------|---------------|---------------|
| `session_id` is a random UUID, not linked to any user account | Anonymous/pseudonymous | ⚠️ Minimal risk — best practice still applies |
| `session_id` is derived from `user_id` (e.g., hash) | Pseudonymous | ✅ Yes — Art. 4(5) pseudonymisation |
| `session_id` stored alongside `user_id` in another table | Personal data | ✅ Yes — full GDPR compliance required |

**Current default:** Aelvyril uses opaque UUID v4 session IDs with no inherent linkage to user identity. The `tenant_id` field defaults to `"default"` for single-tenant deployments.

### GDPR Requirements (if personal data)

| Requirement | Implementation | Status |
|-------------|---------------|--------|
| **Lawful basis** | Legitimate interest (Art. 6(1)(f)) for cost/performance monitoring | ✅ Documented |
| **Purpose limitation** | Stats used only for cost monitoring, optimization, abuse detection | ✅ Enforced by data model |
| **Data minimization** | Only aggregate counts collected; no content stored | ✅ By design |
| **Storage limitation** | Event-level: 30 days; aggregates: indefinite | ✅ `purge_older_than_days()` in store.rs |
| **Accuracy** | API-reported token counts preferred over estimation | ✅ `token_count_source` tracking |
| **Integrity & confidentiality** | SQLite store with tenant isolation; no cross-tenant queries | ✅ Tenant isolation in API |
| **Accountability** | Schema version tracking; audit logging of stats access | ⚠️ Partial — access audit log needed |

### Right to Erasure (Art. 17)

- **Event-level data:** Can be deleted by `session_id` via admin API.
- **Aggregated trends (L3):** Cannot be un-rolled. If erasure is required, the entire day's aggregate must be invalidated or recomputed excluding the session.
- **Procedure:** `DELETE /admin/token-stats/session/{session_id}` → marks events for purge → next compaction removes them.

### Data Portability (Art. 20)

- Export format: JSON
- Endpoint: `GET /token-stats/session/{session_id}/export`
- Includes all event-level fields for the session, formatted per `TokenStatsResponse` schema.

---

## 2. SOC 2 Type II Considerations

### Trust Services Criteria Mapping

| SOC 2 Criteria | Token Stats Relevance | Control |
|----------------|----------------------|---------|
| **CC6.1** — Logical access security | Stats access must be restricted to authorized roles | `access_level` enforcement (`full`/`summary`/`redacted`) |
| **CC7.2** — System monitoring | Cost anomalies indicate potential misuse or compromise | `CostAlertChecker` flags runaway sessions, abnormal retry rates |
| **CC7.3** — Incident detection | Unusual token patterns may signal abuse | Alert thresholds: >3× daily avg, >$10/session, >20% retry rate |
| **A1.2** — Data integrity | Stats must accurately reflect actual usage | `token_count_source` enum tracks provenance; reconciliation flag for >1% delta |
| **PI1.3** — Privacy notice | Users must know what is collected | `TOKEN_USAGE_PRIVACY.md` disclosure document |

### Audit Logging for Stats Access

Every read of token stats should be logged for SOC 2 audit trails:

```json
{
  "timestamp": "2026-04-23T14:30:00Z",
  "actor": "user_123",
  "action": "read_token_stats",
  "resource": "session_abc",
  "access_level": "full",
  "tenant_id": "org_456",
  "ip_address": "10.0.0.1"
}
```

**Status:** Audit log schema defined. Integration with logging subsystem pending.

---

## 3. EU AI Act Disclosure

### Applicability

The EU AI Act requires transparency disclosures for **high-risk AI systems**. Aelvyril is a privacy gateway, not the AI system itself. However, if Aelvyril is deployed as part of a high-risk system, token usage stats may be required as part of the **technical documentation** (Annex IV).

### Required Disclosures

| AI Act Requirement | Token Stats Contribution | Status |
|-------------------|-------------------------|--------|
| **General description** | System architecture including cost/usage tracking | ✅ Architecture documented |
| **Performance metrics** | Token throughput, latency, success rates | ✅ Available via `GlobalTokenStats` |
| **Risk management** | Cost anomaly detection, truncation rate monitoring | ✅ `CostAlertChecker` + truncation tracking |
| **Data governance** | What data is collected, retention, provenance | ✅ `TOKEN_USAGE_PRIVACY.md` |
| **Human oversight** | Alerts for runaway sessions, cost spikes | ✅ Alert thresholds configurable |

### Suggested Disclosure Statement

> "This system logs aggregate token usage statistics (token counts, latency, cost estimates) for the purpose of cost monitoring, performance optimization, and abuse detection. No user prompts, model responses, or file contents are stored. Event-level data is retained for 30 days; aggregate trends are retained indefinitely. Users may request deletion of session-level data and export of their usage statistics in JSON format."

---

## 4. Compliance Checklist

- [x] Data model contains no content fields (audit: `TokenUsageEvent`)
- [x] Retention policy defined (30 days event-level, indefinite aggregates)
- [x] Right-to-delete implemented for event-level data
- [x] Data export (JSON) implemented for portability
- [x] Tenant isolation enforced at API level
- [x] Access levels (`full`/`summary`/`redacted`) implemented
- [x] Privacy disclosure document written (`TOKEN_USAGE_PRIVACY.md`)
- [ ] **PENDING:** Access audit logging integrated with central log system
- [ ] **PENDING:** Legal review of GDPR classification (pseudonymous vs. anonymous)
- [ ] **PENDING:** EU AI Act disclosure reviewed by legal counsel
- [ ] **PENDING:** SOC 2 control evidence collected (sample audit logs)

---

## 5. Action Items for Legal Review

1. **Confirm GDPR classification:** Is `session_id` + `tenant_id` combination linkable to a natural person in our deployment context?
2. **Review retention:** Is 30 days event-level retention compliant with data subject requests?
3. **Review EU AI Act:** Does our use case fall under high-risk system requirements?
4. **Review cross-border:** If EU users' stats are stored on non-EU infrastructure, is SCC/BCR in place?
5. **Sign-off:** Legal counsel to approve `TOKEN_USAGE_PRIVACY.md` and this document.
