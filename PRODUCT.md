# Product

<!-- impeccable:product-schema 1 -->

> Written from the owner's redesign brief and the repository (README.md, docs/spec.md). No live interview took place; facts marked *(inferred)* come from the code, not from the owner.

## Platform

web

## Users

Ordinary, non-technical people running Aelvyril on their own computer. Single user, personal use (docs/spec.md: "Personal, local-first, single user"). They know apps like ChatGPT or Claude, but they don't read logs, write JSON or use a terminal (spec rule, 2026-11-04: "everything that can be done in the UI is done in the UI; the audience is non-coders"). Expected usage: one long, everyday conversation (the Stream) on a laptop or desktop browser, sometimes on a phone-sized screen *(inferred from the e2e phone check)*, with bigger work running as background tasks.

## Product Purpose

A general-purpose AI assistant that runs locally. People connect an AI they already have (Claude, ChatGPT, Gemini, OpenRouter, a local model through LM Studio or Ollama), talk to it in one permanent conversation (the Stream), and add abilities through extensions. The Stream answers quick questions directly. When work needs real tools (files, commands, research, several steps), it starts a background **task** on its own and keeps talking while the task runs. Success means someone with no technical background can create an account, connect an AI, ask for things, see at a glance what the AI is doing, answer when a task needs them, and manage extensions without help.

## Positioning

It's local-first: chats, accounts and keys stay on the person's own computer, and they bring their own AI instead of being tied to one vendor. It should feel like a place or a craft of its own: calm, trustworthy and a little distinctive. It must never feel techy or sparkly, and never look like a ChatGPT, Claude or Gemini clone.

## Operating Context

- Runs at http://localhost:3000, served by the user's own Docker container. It must work offline, so runtime assets can't come from the network (no CDN fonts, remote images or icon fonts).
- Flows: first-run account creation (or sign in), connecting an AI (sign-in, API key or own server), choosing the default AI, talking in the Stream, opening a task to read, steer, stop or delete it, answering requests (Allow/Deny, choices, text), adding or removing extensions by pasting a GitHub link.
- Interaction model (2026 redesign): views **Stream** (home), **Inbox** (tasks by status: Needs you, Working, Done, Older chats), **Quick** (one big box plus recent tasks; also Ctrl/Cmd+K anywhere) and **Board** (the same tasks as cards side by side, each with its status and up to three of its newest results, plus a Stream card with the latest exchange and a one-line box). The switcher appears only after the first task has finished, or when older chats exist from before. A task opens as a side sheet on desktop and full screen on phones. Older plain chats are shown but no new ones are offered; the Stream replaces "New chat".
- On the Board, people arrange cards by dragging a card's handle or with its Move earlier / Move later buttons, and can collapse a card to its title bar. The order and folded cards are remembered in this browser only.
- Task statuses as people see them: Working, Needs your OK, Done, Couldn't finish, Stopped.
- Extensions can render panels in the chat: markdown, table, list, form, diff, action buttons, status lines.

## Capabilities and Constraints

- Preact + Vite single-page app; small bundle (~98 KB gzipped JS). No UI frameworks, icon libraries or drag-and-drop libraries.
- Plain wording is a requirement: "Stream", "task" (never "job"), "Connect an AI", "Extensions". No jargon.
- e2e/ui-smoke.mjs is a contract for accessible names (the "Message" box, the "Stream" region, the "Settings" and "Back" buttons, the "Views" tablist and its "Board" tab, the "Board" panel, Board cards named by their title, and the card buttons "Collapse", "Expand", "Move earlier", "Move later", "Open", "Open the Stream", the "Write to the Stream" box, the "Close task" button and the announcement "… moved to position N of M"), plus placeholders and a few CSS classes in Settings.
- Not built (don't imply it exists): renaming tasks or chats, searching, an update flow, a "test connection" button, resizing, free positioning or pinning Board cards, syncing the Board's arrangement between browsers.

## Brand Commitments

- Name: Aelvyril. Keep it, and keep all product copy.
- Light and dark themes, both intentional (follows the system setting).
- Banned looks: purple/blue gradients, sparkle icons, the default chat-bubble look, "AI glow".

## Evidence on Hand

No logos, illustrations, testimonials or brand assets exist. The only mark is the favicon. Don't invent claims, customers or features.

## Product Principles

1. The person's own computer is home. Say plainly where things live and what stays private.
2. Plain words beat clever words. Every label should be clear to someone who has never set up software.
3. Calm over spectacle. The assistant is a steady helper, not a show.
4. The person stays in charge. Extensions ask, and the person allows or denies.

## Accessibility & Inclusion

WCAG AA contrast in both themes, visible focus, full keyboard use, and respect for reduced-motion settings. Readable type sizes for a general audience *(inferred)*.
