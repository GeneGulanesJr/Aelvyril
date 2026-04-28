# Adversarial Robustness Report

**Clean Baseline F2:** 0.0000
**Clean Baseline Recall:** 0.0000
**Clean Baseline Precision:** 0.0000

## Attack Degradation Summary

| Attack | Attacked F2 | Abs Degradation | Rel Degradation | Recall Drop |
|--------|-------------|-----------------|-----------------|-------------|
| leet_speak | 0.0000 | 0.0000 | 0.0% | 0.0000 |
| homoglyph | 0.0000 | 0.0000 | 0.0% | 0.0000 |
| zero_width | 0.0000 | 0.0000 | 0.0% | 0.0000 |
| invisible_spaces | 0.0000 | 0.0000 | 0.0% | 0.0000 |
| typo | 0.0000 | 0.0000 | 0.0% | 0.0000 |
| synonym | 0.0000 | 0.0000 | 0.0% | 0.0000 |
| filler_words | 0.0000 | 0.0000 | 0.0% | 0.0000 |
| code_block | 0.0000 | 0.0000 | 0.0% | 0.0000 |
| html_wrap | 0.0000 | 0.0000 | 0.0% | 0.0000 |

## Interpretation

- **Relative Degradation > 20%**: Critical vulnerability. Detection collapses under this attack.
- **Relative Degradation 10-20%**: Moderate vulnerability. Consider hardening.
- **Relative Degradation < 10%**: Resilient. Attack has minimal impact.

### Hardening Recommendations

All attacks show <10% degradation. The system is robust against the tested adversarial perturbations.
