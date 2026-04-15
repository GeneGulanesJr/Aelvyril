# Aelvyril Design Language

## Core Concept
Dark, deep teal-to-navy background. The core visual metaphor is a gateway or arch: a single luminous portal that data passes through, surrounded by streams of fragmented text and code radiating outward like intercepted signals. The gateway glows warm gold against the cold dark background, creating a deliberate contrast between the controlled safe path and the chaotic data around it.

## Color Palette

### Base Colors
- Background gradient: `#0a1628` to `#0d2137`
- Primary glow (gateway): `#f5c842` to `#e8a020`
- Data stream accent: `#4dd9e0`
- Alert/flag accent: `#e05a6a`
- Primary text: `#f0f4f8`

### Semantic Tokens
- `--color-bg-1`: `#0a1628`
- `--color-bg-2`: `#0d2137`
- `--color-surface-1`: `rgba(240, 244, 248, 0.06)`
- `--color-surface-2`: `rgba(240, 244, 248, 0.10)`
- `--color-border-subtle`: `rgba(240, 244, 248, 0.16)`
- `--color-text-primary`: `#f0f4f8`
- `--color-text-secondary`: `rgba(240, 244, 248, 0.75)`
- `--color-text-muted`: `rgba(240, 244, 248, 0.56)`
- `--color-accent-gold`: `#f5c842`
- `--color-accent-cyan`: `#4dd9e0`
- `--color-danger`: `#e05a6a`
- `--color-success`: `#4dd9e0`
- `--color-focus-ring`: `rgba(245, 200, 66, 0.55)`

### Interactive State Tokens
- `--state-hover-overlay`: `rgba(240, 244, 248, 0.08)`
- `--state-active-overlay`: `rgba(240, 244, 248, 0.14)`
- `--state-disabled-opacity`: `0.45`

## Typography
Clean, modern, wide-tracked sans-serif. All caps or small caps for the wordmark. Minimal, clinical, confident, not aggressive.

### Type Roles
- Display: 44/52, 600, tracking `0.01em`
- Heading 1: 32/40, 600, tracking `0.005em`
- Heading 2: 24/32, 600, tracking `0.005em`
- Heading 3: 20/28, 600, tracking `0.005em`
- Body large: 18/28, 400
- Body: 16/24, 400
- Label: 14/20, 500, tracking `0.01em`
- Caption/meta: 12/16, 500, tracking `0.015em`

### Wordmark Rules
- Use all caps or small caps.
- Increase tracking to `0.08em`-`0.14em`.
- Prefer medium or semibold weight.

## Layout and Spacing Rules

### Grid and Width
- Use a 12-column grid on desktop.
- Content max width: `1200px`.
- Main text max width: `72ch`.
- On tablet/mobile, collapse to 8/4 columns.

### Spacing Scale
- Use an 8pt base scale: `4, 8, 12, 16, 24, 32, 40, 48, 64`.
- Section spacing: `48-64`.
- Component spacing: `16-24`.
- Dense UI spacing: `8-12`.

### Shape and Depth
- Radius: cards `12px`, controls `10px`, chips `999px`.
- Borders: subtle, low-contrast (`--color-border-subtle`).
- Shadows: minimal. Prefer glow over drop shadow.
- Glow should communicate state, not decoration.

## Component Guidance

### Buttons
- Primary button: dark surface + gold edge or gold glow on hover.
- Secondary button: translucent surface with subtle border.
- Danger button: rose accent only when destructive action is explicit.
- Use clear focus ring (`--color-focus-ring`) for keyboard navigation.

### Inputs and Forms
- Inputs sit on `--color-surface-1` with subtle border.
- Focused fields increase border contrast and add soft gold ring.
- Validation must use text + icon, not color alone.
- Placeholder text uses `--color-text-muted`.

### Cards and Panels
- Card background: `--color-surface-1` or `--color-surface-2`.
- Keep inner padding generous (`16-24`).
- Use cyan for informational highlights, rose for flagged data.
- Avoid high-frequency dividers; group by spacing first.

### Status and Alerts
- Info: cyan accent + neutral text.
- Warning: warm amber accent.
- Error: rose accent + explicit label text.
- Success: cyan accent with "resolved/clean" language.

## Motion and Feel
Data flows in from the edges in fragmented streams, passes through the gateway, and exits clean and ordered on the other side. The gateway itself is still and steady; everything chaotic happens around it, not inside it.

### Motion Rules
- Keep the gateway stable. Animate only surrounding streams and overlays.
- Prefer slow, linear drift for ambient motion (`4s-12s` loops).
- Use short easing for interactions (`120ms-220ms`, ease-out).
- Avoid bounce and playful spring physics.
- Motion should imply control, filtering, and steady processing.

## Accessibility and Usability Requirements
- Minimum contrast: WCAG AA (`4.5:1` for body text, `3:1` for large text/UI).
- Provide a reduced-motion mode for all non-essential animation.
- Never encode state with color alone; pair with icon or label.
- Focus states must be visible on every interactive element.
- Touch targets should be at least `44x44px`.
- Preserve readable text density (line length around `45-75` chars).

## Emotional Tone
Quiet confidence. Not alarming, not corporate. The product sits in the background and handles things; the design should feel the same way.