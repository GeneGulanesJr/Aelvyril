# Phase 1: Aelvyril PII Detection Benchmark Results

**Generated:** 2026-04-25T11:33:03.884757+00:00
**Primary Metric:** F₂ (β=2, recall-weighted)

## Summary

| Metric | Value |
|--------|-------|
| **F₂ Score** | 0.7676 |
| **Recall** | 0.8557 |
| **Precision** | 0.5436 |
| **F₁ Score** | 0.6648 |
| **True Positives** | 605 |
| **False Positives** | 508 |
| **False Negatives** | 102 |

## Per-Entity Breakdown

| Entity Type | Recall | Precision | F₂ | F₁ | TP | FP | FN | Baseline F₂ | Δ F₂ |
|-------------|--------|-----------|----|----|----|----|----|----|------|
| API_Key | 1.0000 | 0.9388 | 0.9871 | 0.9684 | 46 | 3 | 0 | 0.0000 | +0.9871 |
| Credit_Card | 0.8333 | 1.0000 | 0.8621 | 0.9091 | 25 | 0 | 5 | 0.1220 | +0.7401 |
| Date | 1.0000 | 0.5926 | 0.8791 | 0.7442 | 32 | 22 | 0 | 0.8333 | +0.0458 |
| Domain | 0.0000 | 0.0000 | 0.0000 | 0.0000 | 0 | 182 | 0 | 0.0000 | +0.0000 |
| Email | 0.9899 | 0.9899 | 0.9899 | 0.9899 | 98 | 1 | 1 | 0.8988 | +0.0911 |
| IBAN | 1.0000 | 1.0000 | 1.0000 | 1.0000 | 13 | 0 | 0 | 0.3571 | +0.6429 |
| IP_Address | 1.0000 | 1.0000 | 1.0000 | 1.0000 | 65 | 0 | 0 | 1.0000 | +0.0000 |
| Location | 0.6126 | 0.7234 | 0.6320 | 0.6634 | 68 | 26 | 43 | 0.6320 | +0.0000 |
| Organization | 1.0000 | 0.5862 | 0.8763 | 0.7391 | 51 | 36 | 0 | 0.0725 | +0.8038 |
| Person | 0.7914 | 0.7049 | 0.7725 | 0.7457 | 129 | 54 | 34 | 0.7697 | +0.0028 |
| Phone | 0.9800 | 0.2103 | 0.5658 | 0.3463 | 49 | 184 | 1 | 0.7082 | -0.1423 |
| SSN | 0.9667 | 1.0000 | 0.9732 | 0.9831 | 29 | 0 | 1 | 1.0000 | -0.0268 |
| Zip_Code | 0.0000 | 0.0000 | 0.0000 | 0.0000 | 0 | 0 | 17 | 0.0000 | +0.0000 |

## Per-Entity Detail

### API_Key
- TP: 46  FP: 3  FN: 0
- Recall: 1.0000  Precision: 0.9388  F₂: 0.9871  F₁: 0.9684

### Credit_Card
- TP: 25  FP: 0  FN: 5
- Recall: 0.8333  Precision: 1.0000  F₂: 0.8621  F₁: 0.9091

### Date
- TP: 32  FP: 22  FN: 0
- Recall: 1.0000  Precision: 0.5926  F₂: 0.8791  F₁: 0.7442

### Domain
- TP: 0  FP: 182  FN: 0
- Recall: 0.0000  Precision: 0.0000  F₂: 0.0000  F₁: 0.0000

### Email
- TP: 98  FP: 1  FN: 1
- Recall: 0.9899  Precision: 0.9899  F₂: 0.9899  F₁: 0.9899

### IBAN
- TP: 13  FP: 0  FN: 0
- Recall: 1.0000  Precision: 1.0000  F₂: 1.0000  F₁: 1.0000

### IP_Address
- TP: 65  FP: 0  FN: 0
- Recall: 1.0000  Precision: 1.0000  F₂: 1.0000  F₁: 1.0000

### Location
- TP: 68  FP: 26  FN: 43
- Recall: 0.6126  Precision: 0.7234  F₂: 0.6320  F₁: 0.6634

### Organization
- TP: 51  FP: 36  FN: 0
- Recall: 1.0000  Precision: 0.5862  F₂: 0.8763  F₁: 0.7391

### Person
- TP: 129  FP: 54  FN: 34
- Recall: 0.7914  Precision: 0.7049  F₂: 0.7725  F₁: 0.7457

### Phone
- TP: 49  FP: 184  FN: 1
- Recall: 0.9800  Precision: 0.2103  F₂: 0.5658  F₁: 0.3463

### SSN
- TP: 29  FP: 0  FN: 1
- Recall: 0.9667  Precision: 1.0000  F₂: 0.9732  F₁: 0.9831

### Zip_Code
- TP: 0  FP: 0  FN: 17
- Recall: 0.0000  Precision: 0.0000  F₂: 0.0000  F₁: 0.0000


## Baseline Comparison

| Entity Type | Aelvyril F₂ | Baseline F₂ | Δ F₂ |
|-------------|-------------|-------------|------|
| API_Key | 0.9871 | 0.0000 | +0.9871 |
| Credit_Card | 0.8621 | 0.1220 | +0.7401 |
| Date | 0.8791 | 0.8333 | +0.0458 |
| Domain | 0.0000 | 0.0000 | +0.0000 |
| Email | 0.9899 | 0.8988 | +0.0911 |
| IBAN | 1.0000 | 0.3571 | +0.6429 |
| IP_Address | 1.0000 | 1.0000 | +0.0000 |
| Location | 0.6320 | 0.6320 | +0.0000 |
| Organization | 0.8763 | 0.0725 | +0.8038 |
| Person | 0.7725 | 0.7697 | +0.0028 |
| Phone | 0.5658 | 0.7082 | -0.1423 |
| SSN | 0.9732 | 1.0000 | -0.0268 |
| UK_NHS | 0.0000 | 0.0000 | +0.0000 |
| US_ITIN | 0.0000 | 0.0000 | +0.0000 |
| Zip_Code | 0.0000 | 0.0000 | +0.0000 |

