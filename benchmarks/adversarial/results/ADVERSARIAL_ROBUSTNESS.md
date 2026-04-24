# Adversarial Robustness Report

**Clean Baseline F2:** 0.4430
**Clean Baseline Recall:** 0.4118
**Clean Baseline Precision:** 0.6364

## Attack Degradation Summary

| Attack | Attacked F2 | Abs Degradation | Rel Degradation | Recall Drop |
|--------|-------------|-----------------|-----------------|-------------|
| invisible_spaces | 0.0000 | 0.4430 | 100.0% | 0.4118 |
| zero_width | 0.0698 | 0.3733 | 84.3% | 0.3529 |
| typo | 0.2643 | 0.1787 | 40.3% | 0.1765 |
| html_wrap | 0.2743 | 0.1688 | 38.1% | 0.1569 |
| homoglyph | 0.2941 | 0.1489 | 33.6% | 0.1569 |
| leet_speak | 0.3363 | 0.1067 | 24.1% | 0.1176 |
| filler_words | 0.3602 | 0.0829 | 18.7% | 0.0784 |
| code_block | 0.3797 | 0.0633 | 14.3% | 0.0588 |
| synonym | 0.4430 | 0.0000 | 0.0% | 0.0000 |

## Interpretation

- **Relative Degradation > 20%**: Critical vulnerability. Detection collapses under this attack.
- **Relative Degradation 10-20%**: Moderate vulnerability. Consider hardening.
- **Relative Degradation < 10%**: Resilient. Attack has minimal impact.

### Hardening Recommendations

#### Critical Vulnerabilities
- **invisible_spaces**: 100.0% degradation. Prioritize countermeasures (e.g., normalization pipeline, explicit detection rules).
- **zero_width**: 84.3% degradation. Prioritize countermeasures (e.g., normalization pipeline, explicit detection rules).
- **typo**: 40.3% degradation. Prioritize countermeasures (e.g., normalization pipeline, explicit detection rules).
- **html_wrap**: 38.1% degradation. Prioritize countermeasures (e.g., normalization pipeline, explicit detection rules).
- **homoglyph**: 33.6% degradation. Prioritize countermeasures (e.g., normalization pipeline, explicit detection rules).
- **leet_speak**: 24.1% degradation. Prioritize countermeasures (e.g., normalization pipeline, explicit detection rules).

#### Moderate Vulnerabilities
- **filler_words**: 18.7% degradation. Consider detection improvements or input sanitization.
- **code_block**: 14.3% degradation. Consider detection improvements or input sanitization.
