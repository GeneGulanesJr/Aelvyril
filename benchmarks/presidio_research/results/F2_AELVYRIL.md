# Phase 1: Aelvyril PII Detection Benchmark Results

**Generated:** 2026-04-28T07:16:35.560579+00:00
**Primary Metric:** F₂ (β=2, recall-weighted)

## Summary

| Metric | Value |
|--------|-------|
| **F₂ Score** | 0.5863 |
| **Recall** | 0.6283 |
| **Precision** | 0.4625 |
| **F₁ Score** | 0.5328 |
| **True Positives** | 1809 |
| **False Positives** | 2102 |
| **False Negatives** | 1070 |

## Per-Entity Breakdown

| Entity Type | Recall | Precision | F₂ | F₁ | TP | FP | FN |
|-------------|--------|-----------|----|----|----|----|----|
| API_KEY | 0.9627 | 0.9810 | 0.9663 | 0.9718 | 155 | 3 | 6 |
| CITY | 0.0000 | 0.0000 | 0.0000 | 0.0000 | 0 | 0 | 49 |
| CREDIT_CARD | 0.0000 | 0.0000 | 0.0000 | 0.0000 | 0 | 0 | 106 |
| DATE_TIME | 0.0795 | 0.2553 | 0.0922 | 0.1212 | 12 | 35 | 139 |
| EMAIL_ADDRESS | 0.0000 | 0.0000 | 0.0000 | 0.0000 | 0 | 0 | 390 |
| IBAN_CODE | 0.0000 | 0.0000 | 0.0000 | 0.0000 | 0 | 0 | 52 |
| IP_ADDRESS | 1.0000 | 1.0000 | 1.0000 | 1.0000 | 238 | 0 | 0 |
| LOCATION | 0.8667 | 0.6205 | 0.8030 | 0.7232 | 260 | 159 | 40 |
| ORGANIZATION | 0.9804 | 0.6098 | 0.8741 | 0.7519 | 200 | 128 | 4 |
| PERSON | 0.8100 | 0.7991 | 0.8078 | 0.8045 | 533 | 134 | 125 |
| PHONE_NUMBER | 0.9949 | 0.2311 | 0.5990 | 0.3751 | 196 | 652 | 1 |
| STREET_ADDRESS | 0.0000 | 0.0000 | 0.0000 | 0.0000 | 0 | 0 | 140 |
| UK_NHS | 0.0000 | 0.0000 | 0.0000 | 0.0000 | 0 | 8 | 0 |
| URL | 0.0000 | 0.0000 | 0.0000 | 0.0000 | 0 | 780 | 0 |
| US_SSN | 0.8657 | 1.0000 | 0.8896 | 0.9280 | 116 | 0 | 18 |
| US_ZIP_CODE | 1.0000 | 0.3278 | 0.7092 | 0.4938 | 99 | 203 | 0 |

## Per-Entity Detail

### API_KEY
- TP: 155  FP: 3  FN: 6
- Recall: 0.9627  Precision: 0.9810  F₂: 0.9663

### CITY
- TP: 0  FP: 0  FN: 49
- Recall: 0.0000  Precision: 0.0000  F₂: 0.0000

### CREDIT_CARD
- TP: 0  FP: 0  FN: 106
- Recall: 0.0000  Precision: 0.0000  F₂: 0.0000

### DATE_TIME
- TP: 12  FP: 35  FN: 139
- Recall: 0.0795  Precision: 0.2553  F₂: 0.0922

### EMAIL_ADDRESS
- TP: 0  FP: 0  FN: 390
- Recall: 0.0000  Precision: 0.0000  F₂: 0.0000

### IBAN_CODE
- TP: 0  FP: 0  FN: 52
- Recall: 0.0000  Precision: 0.0000  F₂: 0.0000

### IP_ADDRESS
- TP: 238  FP: 0  FN: 0
- Recall: 1.0000  Precision: 1.0000  F₂: 1.0000

### LOCATION
- TP: 260  FP: 159  FN: 40
- Recall: 0.8667  Precision: 0.6205  F₂: 0.8030

### ORGANIZATION
- TP: 200  FP: 128  FN: 4
- Recall: 0.9804  Precision: 0.6098  F₂: 0.8741

### PERSON
- TP: 533  FP: 134  FN: 125
- Recall: 0.8100  Precision: 0.7991  F₂: 0.8078

### PHONE_NUMBER
- TP: 196  FP: 652  FN: 1
- Recall: 0.9949  Precision: 0.2311  F₂: 0.5990

### STREET_ADDRESS
- TP: 0  FP: 0  FN: 140
- Recall: 0.0000  Precision: 0.0000  F₂: 0.0000

### UK_NHS
- TP: 0  FP: 8  FN: 0
- Recall: 0.0000  Precision: 0.0000  F₂: 0.0000

### URL
- TP: 0  FP: 780  FN: 0
- Recall: 0.0000  Precision: 0.0000  F₂: 0.0000

### US_SSN
- TP: 116  FP: 0  FN: 18
- Recall: 0.8657  Precision: 1.0000  F₂: 0.8896

### US_ZIP_CODE
- TP: 99  FP: 203  FN: 0
- Recall: 1.0000  Precision: 0.3278  F₂: 0.7092

