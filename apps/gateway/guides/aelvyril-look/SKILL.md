---
name: aelvyril-look
description: Changing how Aelvyril looks and what sits on the home screen - colours and layout within set limits, your own extra styles, widgets that stay up to date, and checking the person's screen first. Read it before changing the look or layout, before adding, changing or removing a widget, or when the person asks what can be changed.
---

# The look and the home screen

Do not name tools to the person; say what you changed.

## Check the screen first

Before changing layout or size, call get_screen. It tells you the window size, phone, tablet or computer, dark or light mode, and touch or mouse, for each device that opened the app recently. It does not show what is on the screen.

## Changing the look

Only when the person asks. Choose good values yourself instead of asking for colour codes or numbers, then say in one sentence what you changed and that they can ask for it back.

With change_design, within these limits only:

- **Colours**: the accent (buttons and the person's messages), the frame (the bar and the home screen; it must stay dark) and the orb. A colour that would be unreadable is refused with the reason.
- **Home screen tiles**: on the left and right edges, or in a grid under the orb.
- **Orb size**: hidden, small, medium or large. On a phone or small screen keep it medium or small, so the chat box stays on screen.
- **Reading width** in the Stream and tasks: narrow, normal or wide (it only matters on wide windows).
- **Size of everything**: 90 to 120 percent (100 is normal). On a phone, leave it alone unless asked.
- **Extra styles** for anything else: call read_styles first to find the names to use. They cannot load anything from the web or run code, and must keep text readable and the Settings button and the chat box visible.
- **Reset** goes back to the original look. The person can also do that themselves in Settings, Your assistant, "Back to the original look". If extra styles ever make the app unusable, opening the app with ?plain at the end of its address skips them.

You cannot change anything else about the app: not its screens, buttons or behaviour, and not its code.

## Widgets

Anything the person wants kept on screen (the weather, a price, a score, a list, a habit streak, a countdown) goes on their home screen as a widget with show_widget. You describe the card; the app keeps it current. Never write code or an extension to show something on screen.

- A card is one of: a big value at a glance, some text, a list, a table, or a status line. Prefer one compact card.
- It stays current in one of two ways: you update it from the chat (show_widget again with the same id), or the app reads a public web address on a schedule, every 5 minutes to once a day, and fills the card in. Only addresses that need no key or login work.
- After show_widget, read what came back: if some values found nothing, fix them and call it again with the same id. Then tell the person what is on their home screen and how often it updates.
- list_widgets shows the widgets there are; remove_widget takes one off. The person can also remove a widget with the × on its card, and drag cards to arrange them.
- At most 24 widgets.
