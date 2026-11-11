---
name: Aelvyril
description: A local-first AI assistant styled as woven cloth, using natural-dye colours, cut-cloth corners, one endless warp (the Stream) and task cards whose shuttle runs while they work.
colors:
  linen-ground: "#e9e7e0"
  linen-sheet: "#f5f4ef"
  linen-sheet-deep: "#dfdcd3"
  linen-layer: "#f3f2ed"
  linen-layer-hi: "#fbfaf7"
  indigo-ink: "#1b2232"
  slate-thread: "#4f5566"
  seam: "#cdc9be"
  seam-strong: "#aaa596"
  field-line: "#857f70"
  warp: "#b9b3a4"
  indigo-vat: "#24335a"
  indigo-vat-light: "#2f4170"
  oat: "#ece6d6"
  on-oat: "#1f2b4b"
  on-indigo: "#efeadc"
  on-indigo-muted: "#b4bcd3"
  chambray-wash: "#d5dbea"
  weld: "#c49a1c"
  weld-wash: "#f1e6c2"
  weld-ink: "#634b06"
  madder: "#a3283f"
  madder-wash: "#f4dde0"
  overdye-green: "#2c6743"
  overdye-green-wash: "#dbe8dd"
  night-ground: "#12151d"
  night-sheet: "#1a1e29"
  night-layer: "#191d28"
  night-layer-hi: "#222736"
  night-ink: "#e9e4d6"
  night-rail: "#1c2747"
  night-weld: "#e0be55"
  night-madder: "#f28b99"
  night-green: "#8ccc9c"
typography:
  display:
    fontFamily: "Atkinson Hyperlegible Next Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "clamp(1.9rem, 3.4vw, 2.6rem)"
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "-0.02em"
  headline:
    fontFamily: "Atkinson Hyperlegible Next Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "20px"
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "-0.01em"
  body:
    fontFamily: "Atkinson Hyperlegible Next Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.55
  label:
    fontFamily: "Atkinson Hyperlegible Next Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "12px"
    fontWeight: 700
    letterSpacing: "0.14em"
  wordmark:
    fontFamily: "Atkinson Hyperlegible Next Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 750
    letterSpacing: "0.3em"
  mono:
    fontFamily: "ui-monospace, SF Mono, Cascadia Mono, Menlo, Consolas, monospace"
    fontSize: "12.5px"
rounded:
  cut: "2px"
  base: "3px"
spacing:
  gutter: "36px"
  column: "760px"
  beam: "56px"
  inbox-rail: "340px"
  sheet: "min(600px, 50vw)"
  board: "1280px"
components:
  button-primary:
    backgroundColor: "{colors.indigo-vat}"
    textColor: "{colors.on-indigo}"
    rounded: "{rounded.base}"
    padding: "8px 16px"
    height: "40px"
  button-primary-hover:
    backgroundColor: "{colors.indigo-vat-light}"
  button-default:
    backgroundColor: "{colors.linen-sheet}"
    textColor: "{colors.indigo-ink}"
    rounded: "{rounded.base}"
    padding: "8px 16px"
  button-danger:
    textColor: "{colors.madder}"
    rounded: "{rounded.base}"
  switcher-shuttle:
    backgroundColor: "{colors.oat}"
    textColor: "{colors.on-oat}"
    rounded: "{rounded.cut}"
    height: "36px"
  switcher-tab:
    textColor: "{colors.on-indigo-muted}"
    height: "36px"
  task-card:
    backgroundColor: "{colors.linen-sheet}"
    textColor: "{colors.indigo-ink}"
    rounded: "{rounded.base}"
    padding: "14px 16px 12px"
  task-card-waiting:
    backgroundColor: "{colors.weld-wash}"
    textColor: "{colors.indigo-ink}"
    rounded: "{rounded.base}"
  attention-strip:
    backgroundColor: "{colors.weld-wash}"
    textColor: "{colors.indigo-ink}"
    height: "44px"
  suggestion:
    backgroundColor: "{colors.linen-sheet}"
    textColor: "{colors.indigo-ink}"
    rounded: "{rounded.cut}"
    padding: "9px 14px"
    height: "44px"
  inbox-row-active:
    backgroundColor: "{colors.oat}"
    textColor: "{colors.on-oat}"
    rounded: "{rounded.cut}"
  task-sheet:
    backgroundColor: "{colors.linen-layer}"
    textColor: "{colors.indigo-ink}"
    width: "{spacing.sheet}"
  input:
    backgroundColor: "{colors.linen-sheet}"
    textColor: "{colors.indigo-ink}"
    rounded: "{rounded.base}"
    padding: "9px 12px"
    height: "42px"
  chip:
    backgroundColor: "{colors.linen-sheet}"
    textColor: "{colors.slate-thread}"
    rounded: "{rounded.cut}"
    padding: "3px 9px"
  user-turn:
    backgroundColor: "{colors.chambray-wash}"
    textColor: "{colors.indigo-ink}"
  extension-request:
    backgroundColor: "{colors.weld-wash}"
    textColor: "{colors.indigo-ink}"
    rounded: "{rounded.base}"
    padding: "14px 16px"
  board-card:
    backgroundColor: "{colors.linen-sheet}"
    textColor: "{colors.indigo-ink}"
    rounded: "{rounded.base}"
    padding: "8px 16px 14px 34px"
  board-card-waiting:
    backgroundColor: "{colors.weld-wash}"
    textColor: "{colors.indigo-ink}"
    rounded: "{rounded.base}"
  button-needs:
    backgroundColor: "{colors.weld}"
    textColor: "{colors.indigo-ink}"
    rounded: "{rounded.base}"
    padding: "6px 12px"
    height: "36px"
---

# Design System: Aelvyril

> **Out of date (2026-11-11).** The look was changed to a desktop-app window: a dark frame with the menu, content in a floating rounded panel, an electric indigo accent, round marks and soft corners. The colours, shapes and "woven cloth" wording below describe the previous look; the layout, behaviour and accessibility rules still hold. `apps/web/src/styles.css` is the truth until this file is rewritten.

## Overview

**Creative North Star: "The Hand Loom"**

Aelvyril is designed like woven cloth made at home. An indigo beam stands down the left side like the menu of an everyday app and carries the woven-label wordmark, the views (an icon and a name each) and Settings at the foot; on phones it lies across the top and the views become a bar along the bottom. Below it lies undyed linen and one endless warp, the **Stream**: the person's words are indigo-tinted weft bands that cross the thread, the AI's words sit on the open ground, and every background **task** is a card tied onto the warp with a knot. While a task works, a shuttle runs back and forth along the card's weft line. When it needs the person, the shuttle stops and a weld-yellow knot pulses. Finished tasks fold to one quiet line. Calm comes from restraint in ornament and confidence in colour. The only decoration is a 2/2 twill, used for the sign-in cloth, the welcome swatch, the active Settings tab, dialog hems and the selvedge of the task sheet.

The density is unhurried: a single 760px reading column, 16px body text in a typeface designed to be easy to read, and generous space between turns. It deliberately avoids the AI-chat-app look: no chat list, no "New chat", no left/right bubbles, no white floating cards, no gradients, glow or sparkle, and no accent-on-grey shell.

**Interaction model.** One permanent conversation (the Stream) answers quick questions and starts tasks by itself. Four views share the beam: **Stream** (home), **Inbox** (tasks grouped as Needs you, Working, Done, Older chats), **Quick** (one big "What do you need?" box with recent tasks; also an overlay on Ctrl/Cmd+K) and **Board** (every task as a card with the results it produced, side by side, plus a card for the Stream; the person arranges and folds them). The switcher appears only after the first task has finished (or when older chats exist). Until then the person sees only the Stream and its box. A task opens as a sheet sliding in from the right on desktop (the Stream stays visible and steps aside on wide screens) and as a full screen with Back on phones. On touch screens a sideways swipe on the content moves between views.

**Key Characteristics:**
- An indigo beam with an oat woven-label wordmark and a switcher of icon-and-name rows whose oat shuttle (a woven label) slides to the chosen view.
- A warp thread down the reading column, with a knot tying each turn and task to it; day picks cross it.
- Task cards with a live weft line: the shuttle runs while working, a weld knot pulses when it needs you.
- Natural-dye colour roles: indigo, linen, oat, weld, madder and an indigo-over-weld green.
- Cut-cloth corners (2–3px) and hairline seams. Depth comes from layers: the task sheet, the Quick overlay and the Settings page lie over the views.
- One typeface throughout, Atkinson Hyperlegible Next, bundled locally.

## Colors

The palette is a dye cabinet. Every colour is a natural dye or undyed fibre, and each has one job.

### Primary
- **Indigo Vat** (indigo-vat): the beam, the Inbox rail, primary buttons, focus ring in light theme, the shuttle on a working task, and the knot and text of "your" turns. In dark theme the beam and rail become Night Rail, and primary buttons switch to Oat with dark text.

### Secondary
- **Oat** (oat): sewn-in labels, meaning the wordmark, the switcher's shuttle, the gear while Settings is open and the selected Inbox row. It is the light thread on indigo.

### Tertiary
- **Weld Yellow** (weld, weld-wash, weld-ink): reserved for "waiting for you". It marks a task that needs an answer (its card, its knot, the attention strip under the beam, the count on the Inbox tab), a pending extension request, warnings, and the next-step knot on the welcome screen. It is also the focus ring on indigo (beam, Inbox rail) and in dark theme.
- **Madder Crimson** (madder, madder-wash): used only for destructive actions (Stop, Delete?, Disconnect confirm, Remove confirm) and errors.
- **Overdye Green** (overdye-green, overdye-green-wash): done and success, such as finished tool stitches, "Connected ✓", "Saved." and diff additions.

### Neutral
- **Linen Ground** (linen-ground): the page. It is a greige linen, deliberately not cream.
- **Linen Sheet** (linen-sheet, linen-sheet-deep): raised surfaces such as inputs, panels, code, task cards, suggestions and the dialog window.
- **Linen Layer** (linen-layer, linen-layer-hi; night-layer, night-layer-hi in dark theme): the task sheet. Inside it, the layer becomes the local ground and the hi tone the local sheet.
- **Indigo Ink / Slate Thread** (indigo-ink, slate-thread): body text and secondary text (6:1 on the ground).
- **Seam / Seam Strong / Field Line** (seam, seam-strong, field-line): dividers, decorative borders, and input/button outlines (field line is 3:1 or better against both surfaces).
- **Warp** (warp): the thread line and resting knots.
- **Night** set: in dark theme the ground is a neutral ink-black (night-ground), so the indigo beam and Inbox rail (night-rail) still read as dyed cloth.

### Named Rules
**The Reserved Weld Rule.** Weld yellow means "waiting for you", and nothing decorative uses it. If it appears, the person has something to answer.

**The Dye-Has-A-Job Rule.** Madder appears only for destruction or failure, and green only for done. Never use them for emphasis.

## Typography

**Body Font:** Atkinson Hyperlegible Next Variable (fallback: ui-sans-serif, system-ui). Self-hosted via `@fontsource-variable/atkinson-hyperlegible-next`, Latin subset, weights 200–800.
**Mono Font:** the platform's monospace stack, used only for code, tool arguments and diffs.

**Character:** This typeface was designed for readers with low vision. Its letterforms are distinct and open, which suits an audience of ordinary people and gives the product a quiet character of its own without a display face.

### Hierarchy
- **Display** (700, clamp 1.9–2.6rem, 1.2): the greeting and welcome heading, the Settings title and the sign-in name (up to 3rem).
- **Headline** (700, 20px): settings section titles and the task sheet title.
- **Title** (650–700, 15–16px): task card titles, Inbox row titles, panel and dialog titles, provider names, switcher tabs (15px).
- **Body** (400, 16px, 1.55; assistant answers at 1.65): text in the column, which caps line length at about 75 characters. Secondary lines (card previews, row subtitles) run at 13.5–15px in slate.
- **Quick input** (500, 22px; 19–20px on phones and in the overlay): the one large "What do you need?" box.
- **Label** (700, 12px, 0.14em, uppercase): day picks (Today, Yesterday, a date), Inbox group headings and "Recent tasks". Each is the heading itself, never an eyebrow over another heading.
- **Wordmark** (750, 13px, 0.3em, uppercase): the woven label.

### Named Rules
**The Scale-Not-Boxes Rule.** Settings sections get their hierarchy from heading size and a hairline seam, not from boxed cards.

## Layout

The shell is a grid with three rows: the beam (56px), an optional attention strip, and the views. The views stack in one place and only the chosen one shows. Switching slides the new view in from the side it sits on (instant under reduced motion). The Stream, the task sheet and empty states centre a 760px column with a 36px left gutter: the warp thread runs at x=11 and the text starts at 36. Transcript and composer share the column and its gutter, so the thread runs down into the composer. Turns are spaced 22px apart. Settings sections use 28–30px of vertical padding separated by 1px seams.

- **Stream:** the transcript fills the view; status chips, errors and the composer dock at the bottom. The empty state sits low, next to the box: the swatch on the warp, a greeting, one sentence on how tasks work, and four suggestion chips that fill the box.
- **Inbox:** a 340px indigo rail of grouped rows on the left; the chosen task (heading, status, Stop, Delete, transcript, reply box) on the right. With nothing chosen, the most urgent task shows.
- **Quick:** a 720px column starting about 12vh down. The warp comes down from the beam into the big box, then come the suggestions, the "Recent tasks" list and a keyboard hint.
- **Board:** a column up to 1280px wide (24px margins; 12px on phones) holding a masonry of cards: rows of 4px, each card spanning its own height plus a 16px gap, so short cards never leave holes. The column count follows the Board's own width (container query): one below 640px, two from 640px, three from 1000px. With a task sheet open on a wide screen the Board steps aside like the other views and usually drops to one column. A short hint closes the Board ("To arrange, drag a card by its dotted handle, or use its arrow buttons."). With no tasks there is one plain line ("Results from your tasks will appear here.") above the Stream card.
- **Task sheet:** spans the attention strip and the views on the right, `min(600px, 50vw)` wide. At 1180px and wider, the views and the strip step aside by the sheet's width so the Stream stays fully readable.

At 720px and below, the beam lies across the top (wordmark and the Settings icon) and the switcher becomes a bar fixed along the bottom with four equal segments, icon above name, the gutter narrows to 30px, the composer's Stop and Send stack, finished task cards drop their preview, Inbox shows only its rail, and any open task becomes a full screen with "Back to …". The page never scrolls sideways (checked at 360px).

## Elevation & Depth

The system uses tonal layers (ground, then sheet, then deep sheet) plus a few real layers that lie over the views: the task sheet, the Settings page, the Quick overlay and the dialog window. Lift is reserved for things that are ready to take input or lie on top.

### Shadow Vocabulary
- **Lift** (`0 1px 2px rgb(27 34 50 / .08), 0 8px 24px -8px rgb(27 34 50 / .18)`; darker in dark theme): the composer textarea, the Quick box, a task card on hover, a Board card while it is dragged, and the dialog window.
- **Sheet** (`-2px 0 4px rgb(27 34 50 / .06), -28px 0 56px -28px rgb(27 34 50 / .42)`; black in dark theme): the task sheet's left edge, above its twill selvedge.
- **Seam** (`inset -1px 0 0 rgb(0 0 0 / .28)`): the beam's right edge, so the Inbox rail beside it reads as its own piece.

## Shapes

Corners are cut, not rounded: 2px for chips, rows and labels, 3px for buttons, inputs, panels and dialogs. Knots are 10px squares (a 12px rotated square for a pending extension request or a task that needs you). The user band is square on the thread side and slightly rounded on its free end, because it is a strip of weft. The woven label carries a dashed inner stitch line. There are no pills or circles.

## Components

### Buttons
- **Shape:** cut corners (3px), at least 40px tall, weight 600.
- **Primary:** indigo with oat text in light theme, oat with ink text in dark theme.
- **Default:** linen sheet with a field-line outline. Hover deepens to the deep sheet.
- **Danger:** a madder outline on a transparent background, with a madder wash on hover.
- **Link:** muted text, with an underline that appears on hover.

### Chips
- **Style:** rectangular labels (2px) on linen sheet with a seam-strong border and slate text at 13px. A status chip carries the state knot and word; "Needs your OK" is weld-wash with weld-ink text.
- **Suggestions:** 44px-tall linen-sheet buttons (2px corners, seam-strong border, 15px/600 ink). Tapping one fills the box ("Draft an email "), and the person finishes the sentence. It never sends.

### Cards / Containers
- In settings, a "card" is a section: no box, just a hairline seam above it. Extension panels in the thread are linen-sheet blocks with a seam border, a 3px radius, and a title divided by a seam.

### Inputs / Fields
- **Style:** linen sheet, field-line outline, 3px radius, 42px tall. Placeholders use slate text at 4.5:1 or better.
- **Focus:** the border turns indigo, plus a 2px focus outline (indigo in light theme, weld in dark theme and on indigo).

### Navigation
- **Beam:** indigo, a 196px side menu. The woven-label wordmark sits at the top, the switcher below it and Settings (icon and name, 44px) at the foot; it turns oat while Settings is open. On phones the beam is a 52px top bar and Settings is a 40px icon button. Sign out lives in the Settings header, beside Back.
- **Switcher:** a real tablist (Stream, Inbox, Quick, Board), one 44px row per view with a drawn icon and the name; on phones a bottom bar, icon above name. The oat shuttle carries a dashed inner stitch and slides to the chosen tab (0.42s). Inactive tabs are muted oat-on-indigo. A weld count on Inbox shows how many tasks need you. Arrow keys (either direction), Home and End move between views. The view list is data (`VIEWS`): tabs, panels, swipe neighbours and slide directions all read it, so a further view is one more entry.
- **Attention strip:** a slim weld-wash band under the beam with a pulsing weld knot: "**Rename photos** needs your OK · Open →". It opens the task; "+2 more" goes to the Inbox. It is hidden in the Inbox (whose first group says the same) and for the task already on screen.
- **Inbox rail:** indigo, rows 15px with a knot, title, one-line subtitle and a relative time. The chosen row is an oat label. Group headings use the label style with a count. On the rail, done is night-green and failed is night-madder so they read on indigo.

### Task card (signature)
- **Working:** a linen-sheet block tied to the warp by a breathing hollow indigo knot. The title and "Working" sit on top, the latest line from the task below, then the weft line: a 2px warp-coloured line with a 4px indigo shuttle running back and forth (2.8s, ease-in-out), and "Open →". It lifts on hover.
- **Needs you:** weld-wash with a weld border. The weft becomes a dashed weld line with no shuttle; a rotated weld knot pulses on the warp and beside "Needs your OK"; the action reads "Open to answer".
- **Done / Couldn't finish / Stopped:** folded to one line with no box: title, state word, preview and an arrow. The knot is filled green, filled madder, or hollow grey.
- The whole card is one button named "Title, State. Open task".

### Board card
- **Shape:** a linen-sheet block with a seam border and 3px corners, like a working task card but never a button as a whole. Its title bar holds, left to right: the drag handle (two rows of running stitches in a 28px column), the title (a button that opens the task or switches to the Stream) with its status chip below, and three 36px icon buttons: Move earlier, Move later, Collapse/Expand (a chevron that turns to point right when folded). The arrows point left and right; when the Board is one column they turn upright. At either end the matching arrow fades (aria-disabled, still focusable, so focus never drops).
- **Body:** lines up with the title, 34px in, so the handle's column runs down the card like a warp. A working card shows the weft line with its running shuttle, a needs-you card shows the dashed weld weft and the whole card is weld-wash with a weld border, as in the Stream. Then a one-line preview, then up to three results (extension panels) stacked and separated by seams instead of boxes (no card inside a card; their titles drop to 14px, wide tables scroll inside the card). Results that fail validation are skipped and counted in one muted line ("1 result could not be shown"). The foot carries the relative time and an "Open" button; on a needs-you card it is the weld **"Needs your OK · Open"** button (weld fill, ink text), the one filled weld control. A failed result action shows a calm madder notice inside that card ("Couldn't send that to the task: …").
- **Stream card:** the same frame with a short length of the warp in the handle's column: your last message crosses it as a chambray band with a filled indigo knot, the AI's last answer sits on the ground with a hollow knot (Markdown, clipped at a word and faded at the foot when long), and the thread ends in a hollow indigo knot at a one-line box ("Write to the Stream") with Send. "Sent to the Stream." shows in green for four seconds; "Open the Stream" switches views.
- **Order:** the Stream card first, then needs-you cards (longest wait first), then the newest. Until the person arranges anything, new tasks come in at the front and needs-you cards stay ahead; once they have arranged the Board their order holds, new needs-you tasks still come in at the front and other new tasks go to the end. Removed tasks drop out. Order and folded cards are saved per browser (and the Board still works without storage).
- **Drag:** only from the handle (pointer events: mouse, pen, touch; `touch-action: none` on the handle only). After 4px the card lifts (Lift shadow, above the others) and follows the pointer; the card it would land on gets a 2px dashed indigo outline 3px out. Dropping takes that card's place; Esc puts it back. Near the top or bottom edge the Board scrolls by itself. A sideways swipe anywhere else on a card still moves between views, and a drag from the handle never swipes.
- **Moves glide:** after any move (keyboard or drop) every card that changed place glides from its old spot to its new one (0.42s, the house ease-out), and a polite announcement says where it went ("Plan my week moved to position 2 of 4").
- **Polling:** every 4 seconds, only while the Board is the view on screen.

### Day pick
- A short ink-2 dash crosses the warp, and the day ("Today", "Yesterday", or a date) is set in the label style with a seam running to the right. It is an h2 for screen-reader navigation.

### Task sheet
- A linen-layer sheet with a 6px twill selvedge on its left edge. It slides in from the right (0.4s). The header holds the title (20px, focused on open), a status chip, Stop (madder outline) while working, a two-step Delete, and a close icon ("Close task"). Esc closes it and returns focus to the card. On phones it is a full screen with "Back to Stream / Inbox / Quick", and the browser's Back closes it too.

### Quick and the Ctrl/Cmd+K overlay
- A big 64px input on lift beside a primary "Send to Stream". Sending posts to the Stream and switches to it. The overlay is the same component in a dialog window lowered from 12vh with the twill hem. Esc closes it and Tab stays inside.

### Warp Thread
- A 2px warp line runs down every transcript and draws in from the top when a view first shows (0.8s). Each turn's knot shows its state: filled indigo for you, hollow for the AI (breathing while the answer streams in), a stitch for a tool (grey while working, green when done, madder on error), a filled madder knot for an error notice, a weld diamond for a pending request, and a hollow knot for an answered one. While anything works, a short indigo thread feeds down the end of the warp toward the box. The composer ends the thread with a hollow indigo knot.

## Do's and Don'ts

### Do:
- **Do** keep one state vocabulary everywhere: hollow means working, filled means said or done, weld means your turn, madder means it failed.
- **Do** let the person's turns cross the warp as chambray-washed bands (chambray-wash) and keep the AI's turns on the open ground.
- **Do** use the twill only as cloth: the sign-in panel, the welcome swatch, the active Settings tab underline, dialog hems and the task sheet's selvedge.
- **Do** honour `prefers-reduced-motion`. The weft wipe, knot tie, breathing marks, view slides, sheet slide, shuttle run, feed thread and the Board's card glide all switch off; the shuttle parks mid-line and the weld knot keeps a still ring, so "working" and "needs you" still read.
- **Do** say "task", never "job", and keep one status vocabulary: Working, Needs your OK, Done, Couldn't finish, Stopped.
- **Do** give every swipe a button or key: tabs (arrows, Home, End), Back, Close task, Esc. Give every drag one too: Move earlier / Move later on each Board card.

### Don't:
- **Don't** use chat bubbles, purple or blue gradients, sparkle icons or glow (owner's brief).
- **Don't** use coloured side stripes thicker than 1px on rows, notices or cards. The knot on the warp does that job.
- **Don't** use weld, madder or green for decoration.
- **Don't** load fonts or icons from the network. Everything ships with the app.
- **Don't** add a chat list, "New chat", HUD chrome, glass, neon or "AI glow" to suggest the future. Depth comes from layers and motion from the shuttle.
