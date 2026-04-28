# Cross-Lingual PII Detection Results

**Generated:** 2026-04-26T07:04:42.759711+00:00
**Locales:** en_US, de_DE, fr_FR, es_MX
**Total Samples:** 148
**Seed:** 42

## Aggregate Results

| Metric | Value |
|--------|-------|
| **Precision** | 0.0000 |
| **Recall** | 0.0000 |
| **F₁** | 0.0000 |
| **F₂ (β=2)** | 0.0000 |

## Per-Locale Breakdown

| Locale | Samples | Precision | Recall | F₁ | F₂ | Failures |
|--------|---------|-----------|--------|-----|-----|----------|
| en_US (English (US)) | 37 | 0.0000 | 0.0000 | 0.0000 | 0.0000 | 37 |
| de_DE (German (Germany)) | 37 | 0.0000 | 0.0000 | 0.0000 | 0.0000 | 37 |
| fr_FR (French (France)) | 37 | 0.0000 | 0.0000 | 0.0000 | 0.0000 | 37 |
| es_MX (Spanish (Mexico)) | 37 | 0.0000 | 0.0000 | 0.0000 | 0.0000 | 37 |

## Methodology

- Synthetic data generated with stdlib-only generator (no external deps)
- Each locale uses culturally appropriate names, orgs, addresses, phone formats, date formats
- Entity types evaluated: PERSON, ORGANIZATION, EMAIL_ADDRESS, PHONE_NUMBER, IP_ADDRESS, DATE_TIME, LOCATION, CREDIT_CARD
- Evaluation via `/analyze` endpoint with locale-specific `language` parameter
- Span matching: exact (entity_type + start + end)
