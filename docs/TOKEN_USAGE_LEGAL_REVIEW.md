# Token Usage Statistics — Legal & Compliance Review Package

**Document version:** 1.0  
**Last updated:** 2026-04-24  
**Prepared for:** Legal / Compliance / DPO review  
**Scope:** Token usage tracking module (`src-tauri/src/token_usage/`)

---

## 1. Executive Summary

Aelvyril tracks token usage statistics (input/output token counts, cost estimates, latency) for every LLM call that passes through the gateway. **No content is stored.** This document packages the relevant facts for legal review under GDPR, SOC 2, and the EU AI Act.

**Reviewer action required:**
- [ ] Confirm GDPR classification (pseudonymous data vs. non-personal data)
- [ ] Confirm legal basis adequacy
- [ ] Sign off on retention periods
- [ ] Sign off on data subject rights implementation
- [ ] Confirm SOC 2 audit logging coverage
- [ ] Confirm EU AI Act transparency disclosure sufficiency

---

## 2. Data Inventory

### 2.1 What Is Collected

| Field | Example | Notes |
|-------|---------|-------|
| `session_id` | `sess_7a3f...` (UUID v4) | Opaque, non-sequential, random |
| `tool_name` | `chat_completions`, `passthrough` | May be redacted at lower access levels |
| `model_id` | `gpt-4o`, `claude-3-opus` | Public model identifier |
| `tokens_in_system` | 1,200 | Aggregate count only |
| `tokens_in_user` | 8,500 | Aggregate count only |
| `tokens_in_cached` | 3,400 | Aggregate count only |
| `tokens_in_cache_write` | 800 | Aggregate count only |
| `tokens_out` | 2,100 | Aggregate count only |
| `tokens_truncated` | 150 | Aggregate count only |
| `cost_estimate_cents` | 42 | Integer cents, derived from counts × pricing table |
| `actual_cost_cents` | `null` or 41 | Provider-reported cost when available |
| `duration_ms` | 1,340 | Wall-clock latency |
| `success` | `true`/`false` | Boolean outcome |
| `retry_attempt` | 0, 1, 2... | Retry counter |
| `timestamp` | 2026-04-23T14:30:00Z | Rounded to nearest minute for privacy |
| `tenant_id` | `default` | Multi-tenancy isolation key |

### 2.2 What Is NOT Collected

- ❌ User messages or prompts
- ❌ Model responses or completions
- ❌ File contents
- ❌ Query text
- ❌ Search keywords
- ❌ Conversation history
- ❌ Any PII or pseudonymized content

> **Important:** Raw LLM content is sent to third-party providers (OpenAI, Anthropic, Google) under their own data policies. Aelvyril's token stats are entirely separate from that pipeline.

### 2.3 Storage Location

- **Primary:** In-memory (DashMap + AtomicU64), volatile
- **Persistent:** SQLite local database (`token_usage.db`)
- **Cloud:** None. All data is local-first.

---

## 3. GDPR Assessment

### 3.1 Personal Data Classification

**Open question for legal:** Is `session_id` + `tool_name` + `timestamp` + `token counts` personal data under GDPR Article 4(1)?

**Engineering position:** This is **pseudonymous usage data**, not personal data:
- `session_id` is a random UUID with no link to user identity
- No content, no messages, no identifiable patterns
- `tenant_id` defaults to `"default"` in single-tenant deployments

**However:** If the deployment is multi-tenant and `tenant_id` maps to an identifiable organization or user, the data may be considered personal data (or at least pseudonymous data under Recital 26).

### 3.2 Legal Basis (Article 6)

**Claimed basis:** Legitimate interest (Article 6(1)(f))

**Purpose:**
1. Cost monitoring and budgeting
2. System performance optimization
3. Abuse detection (runaway sessions, anomalous retry rates)

**Not used for:**
- Profiling
- Advertising
- Cross-service tracking

**Reviewer action:**
- [ ] Confirm legitimate interest is appropriate (vs. consent or contract necessity)
- [ ] Confirm LIA (Legitimate Interest Assessment) is documented elsewhere

### 3.3 Data Subject Rights (Articles 15–22)

| Right | Implementation | Status |
|-------|---------------|--------|
| **Access (Art. 15)** | Export JSON via admin API (`export_token_stats`) | ✅ Implemented |
| **Rectification (Art. 16)** | Not applicable — aggregate counts only | N/A |
| **Erasure (Art. 17)** | Delete session data via admin API (`purge_token_usage_events`, manual session delete) | ✅ Implemented |
| **Restriction (Art. 18)** | Can disable token tracking by not wiring tracker | ⚠️ Partial — no per-user toggle yet |
| **Portability (Art. 20)** | JSON export available | ✅ Implemented |
| **Objection (Art. 21)** | No direct mechanism; request deletion | ⚠️ Partial |

**Reviewer action:**
- [ ] Confirm erasure scope is sufficient (event-level only; aggregates remain)
- [ ] Confirm restriction/objection handling is adequate for legitimate interest basis

### 3.4 Retention (Article 5(1)(e))

| Data type | Retention | Auto-purge |
|-----------|-----------|------------|
| Event-level records | 30 days | ✅ Yes |
| Daily aggregates | Indefinite | ❌ No |
| Session totals | Indefinite | ❌ No |

**Reviewer action:**
- [ ] Confirm 30-day event retention is proportionate
- [ ] Confirm indefinite aggregate retention is justified (minimal data, no content)

### 3.5 Security (Article 32)

- Data is stored locally in SQLite (not cloud)
- No network transmission of stats
- Tenant isolation enforced in API layer
- Access levels (`full`/`summary`/`redacted`) prevent over-disclosure

**Reviewer action:**
- [ ] Confirm local-only storage satisfies security requirements
- [ ] Confirm tenant isolation is adequate for multi-tenant scenarios

### 3.6 DPO Notification / DPIA

**Engineering assessment:** Likely **not** a high-risk processing activity (no systematic monitoring, no sensitive data, no large-scale profiling). DPIA may not be required.

**Reviewer action:**
- [ ] Confirm DPIA is not required
- [ ] If required, note that one should be completed before production use in EU

---

## 4. SOC 2 Readiness

### 4.1 Trust Services Criteria Mapping

| Criteria | Control | Evidence |
|----------|---------|----------|
| **CC6.1** (Logical access) | Access levels on stats API (`full`/`summary`/`redacted`) | `get_token_stats_with_access()` implementation |
| **CC6.2** (Access removal) | Session deletion API | `purge_token_usage_events()` command |
| **CC6.3** (Access monitoring) | No direct audit log of "who viewed stats" | ⚠️ **Gap identified** |
| **CC7.1** (System operations) | Background orphan cleanup, cost alert monitoring | `spawn_token_usage_monitoring()` in bootstrap/setup.rs |
| **CC7.2** (Monitoring) | Cost alerts for runaway sessions, retry rates | `CostAlertChecker` in `alerts.rs` |
| **PI1.1** (Privacy notice) | Privacy disclosure document | `TOKEN_USAGE_PRIVACY.md` |

### 4.2 Audit Logging Gap

**Identified gap:** There is no audit trail of who accessed token stats. For SOC 2 CC6.3, we should log:
- Who queried stats (user identity, timestamp)
- Which access level was granted
- Which session/tenant was accessed

**Recommended control:** Add an `audit_stats_access(session_id, access_level, user_id)` call to every stats query endpoint.

**Reviewer action:**
- [ ] Accept risk without stats access audit logging
- [ ] Or require implementation before SOC 2 audit

---

## 5. EU AI Act Readiness

### 5.1 Applicability

The EU AI Act requires transparency disclosures for AI systems. Token usage stats support this by providing:
- Per-call token counts (input/output)
- Cost estimates
- Success/failure rates
- Model identification

**Question:** Does Aelvyril's gateway constitute a "high-risk AI system" under Annex III?

**Engineering position:** Likely **not** — Aelvyril is a privacy gateway, not the AI system itself. It proxies requests to third-party models. However, if used in a regulated domain (employment, credit, law enforcement), transparency obligations may still apply.

### 5.2 Transparency Disclosures (Article 52)

Required disclosures that token stats help support:

| Requirement | How token stats help | Status |
|-------------|---------------------|--------|
| Inform users they are interacting with AI | Not directly related to token stats | N/A |
| Provide clear instructions on use | User guide exists | ✅ `TOKEN_USAGE_USER_GUIDE.md` |
| Describe capabilities and limitations | Baseline methodology documents limitations | ✅ `TOKEN_USAGE_BASELINE_METHODOLOGY.md` |
| Provide performance metrics | Success rate, truncation rate, latency | ✅ Implemented |

### 5.3 Record-Keeping (Article 12)

The EU AI Act requires automatic recording of events (`logs`). Token usage events serve as operational logs:
- `event_id` (UUID) provides traceability
- `timestamp` provides temporal record
- `model_id` identifies the AI system component
- `success` indicates outcome

**Reviewer action:**
- [ ] Confirm token usage events satisfy EU AI Act record-keeping requirements for your use case
- [ ] If Aelvyril is deemed a high-risk system, confirm additional logging is implemented

---

## 6. Privacy Safeguards Review

### 6.1 Technical Safeguards

| Safeguard | Implementation | Status |
|-----------|---------------|--------|
| No content storage | `TokenUsageEvent` has no content fields | ✅ Verified |
| Random session IDs | UUID v4 (122 bits entropy) | ✅ Implemented |
| Timestamp rounding | Truncated to minute | ✅ Implemented |
| Rate limiting | Stats API rate-limited via existing `RateLimiter` | ✅ Implemented |
| Tool-name redaction | `access_level: "redacted"` generalizes tool names | ✅ Implemented |
| Tenant isolation | `session_stats_for_tenant()`, `delete_tenant_data()` | ✅ Implemented |
| Deduplication | `event_id` UUID prevents double-counting | ✅ Implemented |

### 6.2 Organizational Safeguards

| Safeguard | Implementation | Status |
|-----------|---------------|--------|
| Privacy policy | `TOKEN_USAGE_PRIVACY.md` | ✅ Documented |
| User guide | `TOKEN_USAGE_USER_GUIDE.md` | ✅ Documented |
| Data export | `export_token_stats()` command | ✅ Implemented |
| Right to delete | `purge_token_usage_events()`, manual delete | ✅ Implemented |
| Retention policy | 30 days event-level, indefinite aggregates | ✅ Documented |

### 6.3 Inference Risk Mitigation

| Risk | Mitigation | Residual Risk |
|------|-----------|---------------|
| Intersection attacks | Timestamps rounded; API rate-limited | Low — diffing still possible over long periods |
| Tool-name fingerprinting | Redaction at lower access levels | Low — `full` access still reveals tools |
| Session enumeration | UUID v4 prevents enumeration | Negligible |
| Cardinality leaks | Non-sequential IDs; no count endpoints | Low |

**Reviewer action:**
- [ ] Accept residual inference risks for single-tenant local deployments
- [ ] For multi-tenant SaaS, consider additional aggregation or differential privacy

---

## 7. Cross-Border Data Transfers

Token usage data is **local-only** (SQLite on user's machine). There are no cross-border transfers of token stats.

**Note:** The LLM calls themselves go to third-party providers (OpenAI, Anthropic, Google) which may involve cross-border transfers. This is outside the scope of token stats and is covered by the providers' own DPA/SCCs.

**Reviewer action:**
- [ ] Confirm local-only storage eliminates transfer mechanism concerns for token stats

---

## 8. Recommended Actions for Legal Sign-Off

### Before Production Release

- [ ] **DPO review:** Confirm GDPR classification (personal vs. pseudonymous vs. non-personal)
- [ ] **LIA completion:** Document Legitimate Interest Assessment for token usage collection
- [ ] **Privacy notice update:** Ensure the app's privacy notice references token usage tracking (or link to `TOKEN_USAGE_PRIVACY.md`)
- [ ] **Retention review:** Confirm 30-day event retention + indefinite aggregates is proportionate
- [ ] **SOC 2 gap:** Decide on stats access audit logging (implement or accept risk)

### Before Multi-Tenant SaaS Deployment

- [ ] **Tenant isolation audit:** Verify `tenant_id` cannot be bypassed in any API call
- [ ] **Cross-tenant leakage test:** Run `test_no_cross_tenant_leakage` and add to CI
- [ ] **Access control hardening:** Enforce `access_level` server-side, not just client-side
- [ ] **Audit logging:** Implement `audit_stats_access` for SOC 2 / GDPR accountability

### Ongoing

- [ ] **Annual review:** Re-evaluate classification if `session_id` becomes linkable to identity
- [ ] **Pricing update review:** LiteLLM pricing fetch may introduce new models; ensure privacy disclosures stay accurate
- [ ] **Incident response:** Add token stats to incident response playbook (data leak suspected → check `access_level`, tenant isolation)

---

## 9. Document Sign-Off

| Role | Name | Date | Status |
|------|------|------|--------|
| Engineering | | | Prepared |
| Legal / DPO | | | ⬜ Pending review |
| Compliance | | | ⬜ Pending review |
| Security | | | ⬜ Pending review |

---

## Appendix A: Source Code References

| Topic | File |
|-------|------|
| Data model | `src-tauri/src/token_usage/mod.rs` |
| Event emission | `src-tauri/src/token_usage/tracker.rs` |
| Store schema | `src-tauri/src/token_usage/store.rs` |
| Cost alerting | `src-tauri/src/token_usage/alerts.rs` |
| Pricing | `src-tauri/src/token_usage/pricing.rs` |
| Tauri commands | `src-tauri/src/commands/token_usage.rs` |
| Background monitoring | `src-tauri/src/bootstrap/setup.rs` (`spawn_token_usage_monitoring`) |
| Privacy disclosure | `docs/TOKEN_USAGE_PRIVACY.md` |
| User guide | `docs/TOKEN_USAGE_USER_GUIDE.md` |
| Baseline methodology | `docs/TOKEN_USAGE_BASELINE_METHODOLOGY.md` |
| Schema policy | `docs/TOKEN_USAGE_SCHEMA_POLICY.md` |
| Migration guide | `docs/TOKEN_USAGE_MIGRATION_GUIDE.md` |
| Operations runbook | `docs/TOKEN_USAGE_OPERATIONS.md` |

## Appendix B: Change Log

| Date | Version | Change |
|------|---------|--------|
| 2026-04-24 | 1.0 | Initial legal review package |
