# Phase 1: Aelvyril PII Detection Benchmark Results

**Generated:** 2026-04-26T09:03:51.706933+00:00
**Primary Metric:** F₂ (β=2, recall-weighted)

## Summary

| Metric | Value |
|--------|-------|
| **F₂ Score** | 0.4872 |
| **Recall** | 0.4449 |
| **Precision** | 0.7859 |
| **F₁ Score** | 0.5682 |
| **True Positives** | 1281 |
| **False Positives** | 349 |
| **False Negatives** | 1598 |

## Per-Entity Breakdown

| Entity Type | Recall | Precision | F₂ | F₁ | TP | FP | FN |
|-------------|--------|-----------|----|----|----|----|----|
| API_Key | 1.0000 | 1.0000 | 1.0000 | 1.0000 | 161 | 0 | 0 |
| Credit_Card | 0.0943 | 1.0000 | 0.1152 | 0.1724 | 10 | 0 | 96 |
| Date | 0.5430 | 1.0000 | 0.5977 | 0.7039 | 82 | 0 | 69 |
| Email | 1.0000 | 1.0000 | 1.0000 | 1.0000 | 390 | 0 | 0 |
| IBAN | 1.0000 | 1.0000 | 1.0000 | 1.0000 | 52 | 0 | 0 |
| IP_Address | 1.0000 | 1.0000 | 1.0000 | 1.0000 | 238 | 0 | 0 |
| Location | 0.0000 | 0.0000 | 0.0000 | 0.0000 | 0 | 0 | 489 |
| Organization | 0.0000 | 0.0000 | 0.0000 | 0.0000 | 0 | 0 | 204 |
| Person | 0.0000 | 0.0000 | 0.0000 | 0.0000 | 0 | 0 | 658 |
| Phone | 0.8325 | 0.3197 | 0.6303 | 0.4620 | 164 | 349 | 33 |
| SSN | 1.0000 | 1.0000 | 1.0000 | 1.0000 | 134 | 0 | 0 |
| Zip_Code | 0.5051 | 1.0000 | 0.5605 | 0.6711 | 50 | 0 | 49 |

## Per-Entity Detail

### API_Key
- TP: 161  FP: 0  FN: 0
- Recall: 1.0000  Precision: 1.0000  F₂: 1.0000  F₁: 1.0000

### Credit_Card
- TP: 10  FP: 0  FN: 96
- Recall: 0.0943  Precision: 1.0000  F₂: 0.1152  F₁: 0.1724

### Date
- TP: 82  FP: 0  FN: 69
- Recall: 0.5430  Precision: 1.0000  F₂: 0.5977  F₁: 0.7039

### Email
- TP: 390  FP: 0  FN: 0
- Recall: 1.0000  Precision: 1.0000  F₂: 1.0000  F₁: 1.0000

### IBAN
- TP: 52  FP: 0  FN: 0
- Recall: 1.0000  Precision: 1.0000  F₂: 1.0000  F₁: 1.0000

### IP_Address
- TP: 238  FP: 0  FN: 0
- Recall: 1.0000  Precision: 1.0000  F₂: 1.0000  F₁: 1.0000

### Location
- TP: 0  FP: 0  FN: 489
- Recall: 0.0000  Precision: 0.0000  F₂: 0.0000  F₁: 0.0000

### Organization
- TP: 0  FP: 0  FN: 204
- Recall: 0.0000  Precision: 0.0000  F₂: 0.0000  F₁: 0.0000

### Person
- TP: 0  FP: 0  FN: 658
- Recall: 0.0000  Precision: 0.0000  F₂: 0.0000  F₁: 0.0000

### Phone
- TP: 164  FP: 349  FN: 33
- Recall: 0.8325  Precision: 0.3197  F₂: 0.6303  F₁: 0.4620

### SSN
- TP: 134  FP: 0  FN: 0
- Recall: 1.0000  Precision: 1.0000  F₂: 1.0000  F₁: 1.0000

### Zip_Code
- TP: 50  FP: 0  FN: 49
- Recall: 0.5051  Precision: 1.0000  F₂: 0.5605  F₁: 0.6711

