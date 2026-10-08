---
name: Aelvyril — The Dispatch Desk
description: "Agent workspace styled as a railway dispatch desk: signal-aspect state lamps, one reserved yellow for Needs you, mono for every measurement."
colors:
  desk: "#0e1217"
  panel: "#12171f"
  panel-raised: "#171e28"
  panel-active: "#1d2634"
  seam: "#232c3a"
  seam-strong: "#334052"
  ink: "#e9eef5"
  ink-muted: "#9aa7b8"
  ink-faint: "#76839a"
  go: "#3fb950"
  caution: "#e3b341"
  danger: "#f85149"
  route: "#4d8bef"
  lamp-off: "#4a5468"
  needsyou: "#ffce00"
  needsyou-ink: "#171207"
  go-ink: "#0b1a0d"
  focus: "#7db1ff"
typography:
  display:
    fontFamily: "Fira Sans, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.5rem"
    fontWeight: 500
    lineHeight: 1.33
    letterSpacing: "-0.025em"
  title:
    fontFamily: "Fira Sans, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 500
    lineHeight: 1.5
    letterSpacing: "normal"
  body:
    fontFamily: "Fira Sans, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.43
    letterSpacing: "normal"
  label:
    fontFamily: "JetBrains Mono, ui-monospace, Cascadia Mono, monospace"
    fontSize: "0.75rem"
    fontWeight: 400
    letterSpacing: "0.05em"
  measure:
    fontFamily: "JetBrains Mono, ui-monospace, Cascadia Mono, monospace"
    fontSize: "0.75rem"
    fontWeight: 400
    letterSpacing: "normal"
    fontFeature: "tnum"
rounded:
  sm: "4px"
  md: "6px"
  lg: "8px"
  full: "9999px"
spacing:
  sm: "8px"
  md: "12px"
  lg: "16px"
components:
  button-primary:
    backgroundColor: "{colors.route}"
    textColor: "#ffffff"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "6px 14px"
  button-approve:
    backgroundColor: "{colors.go}"
    textColor: "{colors.go-ink}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "6px 14px"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.ink-muted}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "6px 14px"
  input-field:
    backgroundColor: "{colors.panel-raised}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "12px"
  board-row-active:
    backgroundColor: "{colors.panel-active}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    padding: "8px 12px"
  band-blocked:
    backgroundColor: "{colors.needsyou}"
    textColor: "{colors.needsyou-ink}"
    typography: "{typography.body}"
    padding: "10px 16px"
  toast:
    backgroundColor: "{colors.panel-raised}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "8px 12px"
---

# Design System: Aelvyril — The Dispatch Desk

## Overview

**Creative North Star: "The Dispatch Desk"**

Aelvyril is an agent workspace styled as a railway signal box. You are the signal operator, not a chat participant: you approve routes (executions) for trains (threads) that run unattended, and every thread ends at the same desk — a plan, a trace, and a diff to merge. The world refuses two category defaults: the **chat transcript with bubbles** (threads are work, not conversations; narration streams as plain desk-log rows, never as speech bubbles) and the **generic GitHub-dark dashboard clone** (state is carried by lit lamps on a dark steel panel, not by stat cards and colored badges).

The ground is dark steel (`#0e1217` family) divided by 1px hairline seams into flat panels — no cards, no glass, no gradients. State is a lit lamp drawn from a fixed signal-aspect vocabulary (amber spec'ing, green running/cleared, red abandoned, dim unlit draft), plus one Schiphol-yellow held exclusively for "Needs you" moments. Fira Sans is the single UI voice; JetBrains Mono carries every measurement, always `tabular-nums`. The signature moments: the route line lighting station by station as the agent works, and the yellow band igniting when the interlock demands a human.

**Key Characteristics:**
- Dark steel grounds (`desk → panel → panel-raised → panel-active`), separated by hairline seams, flat by default
- Signal-aspect state vocabulary; blue is the route/primary-action color, never a status lamp
- One reserved yellow — "Needs you" only, never decorative
- JetBrains Mono for every measurement, always `tabular-nums`
- Lucide icons only (`aria-hidden`, never unicode/emoji); binding product vocabulary ("thread", never "conversation")
- Motion exists only to convey state; `prefers-reduced-motion` kills all of it

## Colors

Palette character: near-black blue-gray steel grounds, three signal lights (green / amber / red) plus a route blue, and a single saturated yellow kept in reserve.

### Primary
- **Route Blue** (`--color-route`, #4d8bef): the set-route color. Primary actions (Ask, Submit answers, sign in), active tab underline, input `focus` borders, `caret-color`, `accent-color`, route-line connectors (at 60% opacity), diff hunk headers, the plan's file chips, the user-message and verdict icons in the trace. It is a *direction*, not a status.
- **Focus** (`--color-focus`, #7db1ff): the `:focus-visible` outline (2px, offset 1px). A lighter tint of route; interaction only.

### Secondary — signal aspects
- **Go** (#3fb950): the clear-route aspect. The `running` lamp (pulsing) and `reviewed` lamp; solid `bg-go` carries the desk's terminal actions (Merge, Approve & run) with dark **Go Ink** (`--color-go-ink`, #0b1a0d) as their label color. Also diff additions (`+` lines at 10% wash, `+N` stats) and the success toast icon.
- **Caution** (#e3b341): the amber aspect. `spec'ing` lamp (pulsing), `queued` (hollow amber ring), the degraded band, the spec panel's lamp/border, risks and subagent icons. Doubles as the text-selection background (with needsyou-ink text).
- **Danger** (#f85149): the red aspect. `abandoned` lamp, the error band, kill-all / Stop / abandon treatments, tool-error crosses, diff removals (`-` lines at 10% wash, `-M` stats).
- **Lamp Off** (#4a5468): the unlit lamp. `draft` — a thread with no route set.

### Tertiary — the reserved yellow
- **Needs You** (`--color-needsyou`, #ffce00) on **Needs You Ink** (`--color-needsyou-ink`, #171207): the blocked status band, the blocked lamp on the board, and the inverting action buttons inside the band. Nothing else. Not a lifecycle aspect, not decoration, not a highlight.

### Neutral
- **Desk** (#0e1217): page ground and the board column; also the browser `theme-color`.
- **Panel** (#12171f): the main working column, header band, tab strip, composer plate.
- **Panel Raised** (#171e28): inputs, primary button plates, toasts, skeleton blocks, the spec panel.
- **Panel Active** (#1d2634): the selected board row — the one "pressed-in" surface.
- **Seam** (#232c3a): the 1px hairline that divides everything.
- **Seam Strong** (#334052): emphasized seams — button borders on raised plates, passed route stations, scrollbar thumbs.
- **Ink** (#e9eef5): primary text — titles, narration, user messages.
- **Ink Muted** (#9aa7b8): secondary text — plan steps, tool names, ghost buttons, usage readouts.
- **Ink Faint** (#76839a): tertiary text — clocks, durations, line numbers, group labels, placeholders.

### Signal aspect map (state → lamp)
Every thread status renders through `STATUS_META` — a lamp class, a text class, and an optional pulse. No ad-hoc status colors anywhere.

| Status | Lamp | Text | Pulse |
|---|---|---|---|
| `draft` | bg-lamp-off (#4a5468) | text-ink-faint | no |
| `queued` | transparent, 1px caution ring | text-caution | no |
| `spec'ing` | bg-caution (#e3b341) | text-caution | yes |
| `running` | bg-go (#3fb950) | text-go | yes |
| `reviewed` | bg-go (#3fb950) | text-go | no |
| `merged` | transparent, 1px go ring | text-go | no |
| `abandoned` | bg-danger (#f85149) | text-danger | no |
| `blocked` (a state, not a status) | bg-needsyou (#ffce00) | on the yellow band | yes |

**The Reserved Yellow Rule.** `#ffce00` means "Needs you" and nothing else: the blocked band, the blocked board lamp, and the inverting buttons inside them. It never appears as a lifecycle aspect, a highlight, or decoration.

**The Aspect Rule.** Any new state must join `STATUS_META` as a lamp + text class (+ pulse). Railway-true: green means the route is clear and the train is moving. Blue (`route`) is the set-route/primary-action color and is **never** a lifecycle lamp.

**The No-Inline-Hex Rule.** Components consume tokens via Tailwind utilities (`bg-panel`, `text-ink-muted`, `border-seam`, `bg-needsyou`) — never inline hex.

## Typography

**UI Font:** Fira Sans (400 / 500 / 600 / 700; `ui-sans-serif, system-ui` fallback) — loaded via `next/font` as `--font-fira`.
**Measurement Font:** JetBrains Mono (`ui-monospace, "Cascadia Mono"` fallback) — loaded as `--font-jetbrains`.

**Character:** one humanist sans voice for everything human, and a metro-clock mono that owns every number. The pairing reads as instrument panel, not marketing site.

### Hierarchy
- **Display** (Fira Sans 500, 24px/32px, tracking −0.025em): hero headline only — "Set the work in motion." on the new-thread screen; the sign-in wordmark scales it up with wide tracking.
- **Title** (Fira Sans 500, 16px/24px): the thread title in the desk header. The "AELVYRIL" wordmark is instead mono, 12px uppercase, tracked 0.2em (0.3em on sign-in).
- **Body** (Fira Sans 400, 14px/20px): the base voice — narration (`leading-relaxed`), plan steps, band copy, buttons, board rows.
- **Label** (JetBrains Mono 400, 12px, uppercase, letter-spacing 0.05em): board group names, route station names, spec field labels, status labels (status labels take their aspect's text color).
- **Measure** (JetBrains Mono 400, 12px, `tabular-nums`): every number — cost (`$0.0000`), tokens (`1.2k tok` / `3.4M tok`), 24h clocks, durations (`850ms` / `12.4s`), board rel-times (`now` / `3m` / `2h` / `5d` — no "ago"), diff line numbers, `+N/−M` stats, tab counts.

**The Mono Measure Rule.** If it is a measurement, it is JetBrains Mono with `tabular-nums` — cost, tokens, time, duration, line numbers, file paths, station names. Fira Sans never renders a number the operator compares or scans.

## Layout

- **The two-column desk.** A fixed 280px describer board (`bg-desk`, `border-r` seam) beside a fluid desk column (`bg-panel`). Both `h-screen`; the page itself never scrolls — panes own their scrolling.
- **Main column order (top to bottom):** mobile desk bar (below `md` only) → exactly one status band → thread header → route line → output tabs (flex-1, scrolling panes) → spec panel → composer pinned at the bottom.
- **Responsive:** below `md` (768px) the board becomes a slide-in drawer (`shadow-drawer` over a `black/60` scrim); below `sm` (640px) header action labels and keyboard hints hide.
- **Density:** compact instrument spacing — sidebar rows `py-2`, timeline rows `py-1`, panels `p-3`, row gutters `px-4`, base type 14px.
- **Reading measures:** narration and plan copy cap at `max-w-prose` (~65–75ch); the hero caps at `max-w-2xl`; the desk itself has no max width.
- **Live pinning:** the trace auto-scrolls to the newest row while pinned; scrolling up (beyond an ~80px tolerance) releases the pin and offers a "jump to now" pill instead.
- **Loading:** the skeleton mirrors the board's shape (pulsing `panel-raised` blocks in board + desk positions) — never a bare "loading…" line.

## Elevation & Depth

**The Flat Desk Rule.** Depth is tonal, not cast: four ground steps (`desk → panel → panel-raised → panel-active`) separated by 1px seams. No cards, no glass, no gradients, no hover-lift. Shadows exist only for chrome that genuinely floats above the desk.

### Shadow Vocabulary
- **Drawer** (`0 8px 24px rgb(0 0 0 / 0.5)`): the mobile board drawer — the only full-panel shadow.
- **Pop** (`0 6px 16px rgb(0 0 0 / 0.45)`): small floating chrome — toasts, the "jump to now" pill, the hero composer container.

## Shapes

- **6px radius (`rounded-md`):** all interactive chrome — buttons, inputs, search, toasts.
- **4px radius (`rounded`):** small chips (workspace, subagent mode, dialog action), the diff file cards, the plan's file chips, the band's action buttons.
- **Pill (`rounded-full`):** signal lamps (8px on board/header, 10px on route stations) and the "jump to now" pill.
- **8px radius (`rounded-lg`):** the hero composer container only.
- Borders are always 1px hairlines (`seam`); emphasis steps up to `seam-strong`. The brand mark is a 32px signal head (`rx 7`) with three aspect circles (danger / caution / go).

## Components

### Describer board (thread sidebar)
The tabular thread list — a station board, not a nav menu. Sections by board grammar: **Needs you** (any blocked thread — the escalation outranks lifecycle status and pulls the row out of its usual group), **In flight** (`queued` / `spec'ing` / `running`), **Desk** (`draft`), **Closed** (`reviewed` / `merged` / `abandoned`). Newest first within a group; empty groups are omitted. Group labels are mono uppercase 12px in ink-faint. Row anatomy: 8px aspect lamp (blocked rows take the pulsing reserved-yellow lamp) → title (14px ink, truncating) → mono sub-line (status label in aspect color · rel-time) → right-aligned mono cost when usage exists. Active row is `bg-panel-active`; hover is `bg-panel-raised`. Top: wordmark, New thread button, search (title substring, id fallback). Bottom: **kill all** — a two-step arm ("kill all" → "confirm kill all?" + "no"), danger-bordered.

### Thread header
`bg-panel` band under the bottom seam: title (16px medium, truncating) · status lamp + mono uppercase aspect label · workspace chip (mono, seamed) · mono usage readout (`$cost · N tok`). **Merge** appears only when `reviewed` and is the one solid-green button in the header — the desk's terminal action outranks the utility row. Rename / Abandon / Delete are quiet icon+label ghosts; destructive ones arm in place ("confirm abandon?" in danger + a quiet "no"). Live SSE status wins over the mount-time snapshot.

### Status band (exactly one, by precedence)
The main column carries **one** band at a time: **blocked** (reserved yellow, `role="alert"`, ignites on arrival) > **error** (danger wash at 15%, dismissable, optional "Retry turn") > **degraded** (amber wash at 15%, persistent context, `role="status"`, no dismiss). The lower bands stay logically true but yield the surface to the higher one. The yellow band carries **exactly one message and one action**, both inside the band: "Answer the questions" (question), "Open the trace" (dialog), "Review & approve" (gated); capped explains the budget cap. Action buttons invert the band (`bg-needsyou-ink`, `text-needsyou`).

### Route line (signature)
The thread's lifecycle as a horizontal station strip: `SPEC → RUN → VERIFY → REVIEW → MERGE` (mono uppercase 12px). Station states: **active** — the status's aspect lamp, pulsing while the phase is live, label in ink; **passed** — dim lit `bg-seam-strong`, label ink-faint; **future** — 1px seam outline, transparent fill, label ink-faint. Connectors are 1px lines: `bg-route/60` behind the reached run, `bg-seam` ahead. `routePosition` maps: draft/queued/abandoned → reached SPEC, nothing active; spec'ing → SPEC active; running → RUN; reviewed → REVIEW; merged → MERGE. **Known vocabulary limitation:** `verify` never carries an active aspect — the gateway auto-verifies inside `running`, so no lifecycle status maps to it; verify lights only as passed once REVIEW is reached. The new-thread hero reuses the strip with `status="draft"` as a promise of the route.

### Output tabs (Plan / Trace / Diff)
Underline tabs on a `bg-panel` strip: active tab is a 2px route-blue underline with medium ink; inactive are ink-muted, brightening on hover. The trace tab carries a mono count of timeline items. **Smart default:** until the user picks a tab, the desk follows the data — `diff` if a diff exists, else `plan` (plan steps or a spec draft), else `trace`, resting on `plan` — re-evaluated as SSE data lands; the first manual choice pins it. Tablist is one tab stop with roving ←/→. Panes own their scrolling.

### Trace timeline (the desk log)
One row per event, clock first: a 56px mono tabular clock column (24h), then an aspect icon, then content. Narration is the reading measure — up to `max-w-prose`, 14px `leading-relaxed` at 90% ink — with a 3×16px route-blue caret blinking (`steps`) only while the stream is live. Tool rows are expandable `<details>`: wrench icon, mono tool name, summarized args (first scalar values, truncating), and on the right the paired result — a spinner while in flight, then a go check or danger cross plus the wall-clock duration in mono. Expanded rows reveal raw args / verdict JSON indented to 76px. Other rows: user (route corner-arrow — you set the route), subagents (caution users icon, names joined " · ", mode chip, tasks indented), sandbox, promote, verdict (route scale icon), dialog (danger icon when blocked, action chip). Auto-scroll pins to the bottom; a "jump to now" pill appears when the pin releases.

### Diff cards
One seamed `<details>` card per file (first open by default). Summary: mono file path (truncating), `+N` in go and `−M` in danger (counted from patch lines, excluding `+++`/`---` headers), and a copy button that swaps Copy → go Check for 1.5s without folding the card. Lines are mono 12px/20px: `+` rows go-on-go-wash, `-` rows danger-on-danger-wash, `@@` headers route, context ink-faint. Line numbers are true new-file numbers walked from the `@@` hunk headers — context and `+` rows carry the number, `-` rows (old file) stay blank, hunk headers get none — in a 36px right-aligned `select-none` column.

### Spec interview
An amber-seamed panel (`border-t` caution/40, `bg-panel-raised`) below the working surface. Header: pulsing amber lamp + mono uppercase label — "Spec interview" when questions are open, "Draft under negotiation" when only a draft exists. Questions render as labeled fields (inputs/selects, `focus` border route) with a route-blue **Submit answers** that stays disabled until every question is answered. The draft is an editable two-column form (Goal and Plan span full width; Files and Risks half) — agent-drafted, user-edited, PATCHed with a 400ms debounce and flushed on blur; the field under edit is never reconciled away by an incoming re-draft. **Approve & run** is the solid-go button (Play icon, go-ink label); Cancel is a quiet seamed ghost. During a gated stop the panel is force-visible so approval stays reachable.

### Composer
Pinned to the bottom of the desk on a `bg-panel` plate. Auto-growing textarea (starts at ~3.4rem, grows to a 200px cap, then scrolls internally) with route-blue focus border and ink-faint placeholder. **Enter** sends (Ask mode); **Shift+Enter** inserts a newline; IME composition is respected (Enter during composition never sends). No Cmd/Ctrl+Enter binding exists in the build. Buttons: **Ask** (route-blue solid, send icon), **Ask + spec** (seamed ghost — forces the interview), **Stop** (danger-bordered, only while a turn is in flight). Right-aligned hints in ink-faint: "Enter to send · Shift+Enter for a new line", or "will queue as a steer" when typing during a live turn. A failed send keeps the typed text.

### Toasts
Confirmations only — rename saved, thread abandoned, diff merged, kill-all done. Bottom-right stack (`aria-live="polite"`), seamed raised plates with a `shadow-pop`, igniting on arrival, auto-dismissed after 4s: go check icon for `ok`, ink-muted cross for `info`. **Errors never become toasts — the status band stays the single error surface.**

### Browser surfaces (global chrome)
The world carries into the browser: text selection is amber (`caution` background, needsyou-ink text); the caret is route blue everywhere; `:focus-visible` is a 2px focus-blue outline offset 1px; scrollbars are thin with a seam-strong pill thumb on a transparent track; form `accent-color` is route blue; link underlines sit 3px low; `<summary>` markers are stripped (disclosure rows draw their own affordances).

### Motion grammar
**The State-Or-Nothing Rule.** An animation exists only because a state exists to convey; if you cannot name the state, there is no animation. Exactly four motions, and `prefers-reduced-motion: reduce` kills every one:
- **Lamp pulse** (opacity 1 → 0.55 → 1, 2.4s ease-in-out, infinite): a lamp breathes only while its phase is live — `running`, `spec'ing`, and blocked.
- **Band ignite** (fade + 3px settle, 220ms, `ease-desk`): a band or toast arriving demanded attention.
- **Stream caret** (opacity steps, 1s, infinite): narration is streaming right now.
- **Color transitions** (150ms): the universal hover/focus response — colors only, never transforms.
- The tool-row spinner is the single borrowed Tailwind spin, conveying "in flight" on a paired result that hasn't landed.

### Keyboard map
- **Enter** — send from the composer (IME-safe); **Shift+Enter** — newline.
- **← / →** — move between Plan / Trace / Diff tabs (roving tabindex; the tablist is one tab stop).
- **Enter / Space** — toggle disclosure rows (tool args, verdicts, diff files).
- **Tab** — standard order; every focus lands the 2px focus ring. No Esc bindings in the build.

### Crew mode (the inhabited desk)
A persisted interface mode (`localStorage` key `aelvyril.ui-mode`, `desk` default, invalid → desk) toggled by the segmented **Dispatch / Crew** control in the board footer (`ModeToggle`, mono uppercase labels, TrainFront/Users icons, `aria-pressed`). Crew mode does NOT re-skin the world — it inhabits it: same tokens, same data surfaces, one additional encoding of state.

**The engineer rig** (`components/crew/engineer.tsx`): an authored SVG signal technician, never an emoji. The helmet lamp carries the thread's aspect color (with `animate-lamp-pulse` only while live); the body and limbs are `fill-panel-active stroke-seam-strong`, the head `fill-panel-raised stroke-seam-strong`. Poses map 1:1 to real state and nothing else:

| state | pose | lamp |
|---|---|---|
| degraded | `unplugged` (dangling cord, slumped) | `off` |
| running / spec'ing | `working` (hammering arm) | go / caution |
| queued | `idle` (on the platform) | caution |
| draft | `idle` | off |
| abandoned | `idle` | danger |
| reviewed | `idle` (standing at REVIEW, waiting on you) | go |
| merged | `done` (arm raised) | go |
| blocked band | `attention` (waves at you) | `needsyou` |

**Where the engineer lives (RTS track):** the crew route strip is a fixed-proportion rail (stations at 0/25/50/75/100%); the engineer stands ON the rail at `active ?? reached` and physically WALKS to the next station when it changes — `left` transitions over 600ms `ease-desk` with the walking pose and the sprite facing the direction of travel (the ONE orchestrated motion; timer cleaned up). While a tool is in flight (`workPending` = run live + newest tool call without a result) a caution spark-ring pulses at the station; degraded parks everything. The blocked band swaps its `Hand` icon for the attention engineer. The new-thread hero inherits the idle engineer automatically (draft → idle at the dim SPEC station).

**Crew drones** (`components/crew/crew-token.tsx` + `drone.tsx`): dispatched subagents render as hovering drone UNITS in the yard below the rail (authored sprite, caution visor, thruster bob while the run is live) — not name chips. Hovering a unit shows the REAL task it was spawned with (from `subagent_spawn`); ≤4 drones + `+N` overflow; null in desk mode or when empty. Drones are aria-hidden — the trace stays the authoritative surface.

**Crew rules:** every crew animation encodes real SSE-derived state (motion without state is banned, same as desk); reduced-motion freezes the rig like everything else; the reserved yellow is still needs-you-only — the attention engineer's lamp is the one yellow figure on a blocked screen; crew mode adds NO new information surfaces (trace, diff, board stay authoritative and untouched).

### Deferred by vocabulary (cited, not forgotten)
- **The cap line** (right-aligned usage against a hard cap) awaits the cap on the wire: the gateway enforces `GATEWAY_MAX_THREAD_COST_USD` server-side and announces it as a `capped` blocked band; the UI renders the cost column but draws no gauge until remaining budget is exposed.
- **Concurrent agent columns** (duration-encoded side-by-side spans) await per-agent timing spans in the SSE vocabulary; until then subagents render as an indented task list under a single row.

## Do's and Don'ts

### Do:
- **Do** consume tokens as Tailwind utilities (`bg-panel`, `text-ink-muted`, `border-seam`, `bg-needsyou`) — never inline hex.
- **Do** render every new state through the aspect map (lamp + text class + optional pulse); extend `STATUS_META` rather than inventing a color.
- **Do** set every measurement in JetBrains Mono with `tabular-nums`.
- **Do** keep errors in the status band and use toasts for confirmations only.
- **Do** arm destructive actions in place ("confirm …?" + "no") — kill-all, delete, abandon.
- **Do** use binding product vocabulary: thread, spec interview, Ask / Ask + spec, approve & run, Needs you, degraded, kill-all, workspace.
- **Do** add animation only when a state demands it, and honor `prefers-reduced-motion`.

- **Do** let the engineer embody state in crew mode (pose/lamp strictly from the mapping table) — the crew layer is a second encoding of real state, never a mascot beside it.
### Don't:
- **Don't** use the reserved yellow (`#ffce00`) for anything but "Needs you" surfaces and their inverting buttons.
- **Don't** use route blue as a status lamp — blue is the set-route/primary-action color; green is "clear and moving".
- **Don't** introduce cards, glass, gradients, or hover-lift — surfaces are flat panels divided by 1px seams.
- **Don't** render state as chat bubbles or a transcript; narration is desk-log rows under a clock column.
- **Don't** use emoji, unicode glyphs, or icon fonts — lucide icons only, `aria-hidden`.
- **Don't** say "conversation" in the UI — the unit of work is a **thread**.
- **Don't** add a second UI font or set a number in Fira Sans where operators compare values.
- **Don't** clone the GitHub-dark dashboard — no stat cards, no colored badge pills for status; state is a lamp.
