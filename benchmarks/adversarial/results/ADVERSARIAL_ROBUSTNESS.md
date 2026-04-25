# Adversarial Robustness Report

**Clean Baseline F2:** 0.5635
**Clean Baseline Recall:** 0.5676
**Clean Baseline Precision:** 0.5477

## Attack Degradation Summary

| Attack | Attacked F2 | Abs Degradation | Rel Degradation | Recall Drop |
|--------|-------------|-----------------|-----------------|-------------|
| invisible_spaces | 0.0192 | 0.5443 | 96.6% | 0.5519 |
| zero_width | 0.2575 | 0.3060 | 54.3% | 0.3300 |
| html_wrap | 0.3520 | 0.2115 | 37.5% | 0.2162 |
| leet_speak | 0.3872 | 0.1763 | 31.3% | 0.2013 |
| typo | 0.4030 | 0.1605 | 28.5% | 0.1792 |
| code_block | 0.4389 | 0.1246 | 22.1% | 0.1273 |
| homoglyph | 0.4677 | 0.0958 | 17.0% | 0.1166 |
| filler_words | 0.5244 | 0.0391 | 6.9% | 0.0377 |
| synonym | 0.5616 | 0.0019 | 0.3% | 0.0021 |

## Interpretation

- **Relative Degradation > 20%**: Critical vulnerability. Detection collapses under this attack.
- **Relative Degradation 10-20%**: Moderate vulnerability. Consider hardening.
- **Relative Degradation < 10%**: Resilient. Attack has minimal impact.

### Hardening Recommendations

#### Critical Vulnerabilities
- **invisible_spaces**: 96.6% degradation. Prioritize countermeasures (e.g., normalization pipeline, explicit detection rules).
- **zero_width**: 54.3% degradation. Prioritize countermeasures (e.g., normalization pipeline, explicit detection rules).
- **html_wrap**: 37.5% degradation. Prioritize countermeasures (e.g., normalization pipeline, explicit detection rules).
- **leet_speak**: 31.3% degradation. Prioritize countermeasures (e.g., normalization pipeline, explicit detection rules).
- **typo**: 28.5% degradation. Prioritize countermeasures (e.g., normalization pipeline, explicit detection rules).
- **code_block**: 22.1% degradation. Prioritize countermeasures (e.g., normalization pipeline, explicit detection rules).

#### Moderate Vulnerabilities
- **homoglyph**: 17.0% degradation. Consider detection improvements or input sanitization.
