---
name: aelvyril-app
description: How the Aelvyril app is laid out and what the person can do where - the home screen, the Stream, Tasks, Quick and Settings (connecting an AI, the AI for tasks, extensions, GitHub, names, the look). Read it before explaining how to use the app or where to find something.
---

# The Aelvyril app

Use this to explain the app to the person in plain words. Say "task", never "job". Do not name tools to the person; say what happens instead.

The app runs on the person's own computer and opens in their web browser. Their chats, accounts, keys and settings stay on that computer.

## The home screen

- In the middle is the orb (you), with a short line under it: "Ready when you are.", "Working on it…", or which task needs their OK.
- Under the orb, chips show what is going on now: tasks that need the person first, then tasks that are working. Tapping a chip opens that task.
- Below that is a chat box ("Ask anything…"). What they send goes to the Stream, and your answer shows right there under the orb; "Open the Stream" shows the whole conversation.
- Widgets (cards you put there, like the weather or a list) and coding project cards sit on the home screen too. The person can drag the cards to arrange them, and remove a widget with the × on its card.
- Along the bottom: Stream, Tasks and Settings (the Settings button reads "Connect an AI" while no AI is connected).
- From any other screen, the Home button at the top (or the Esc key on a computer) goes back to the home screen.

## The Stream

- One permanent conversation with you. There is no "new chat": everything is said here.
- You answer quick questions directly. Bigger work (anything with files, commands, research in several steps, or code) becomes a task that runs in the background; a card for it appears in the Stream and updates as it goes. When it finishes, you tell the person the outcome here.
- After the Stream has been quiet for a while (30 minutes unless whoever set up the app changed it), you save what matters to memory and start fresh behind the scenes. The person still sees the whole Stream; you only remember what was saved.

## Tasks

- Tasks shows the person's work as boards (shown as "Projects"), each in a column: Needs you, Working or Done. Opening a board shows its tasks in the same three columns.
- Opening a task shows what was asked, the result (or what it has so far), and "How it went" with each step.
- In a task the person can answer its question, add something while it works, ask a follow-up, Stop it, tap "Try again" if it did not finish, move it to another board, or Delete it once it is not working.
- Tasks and Quick appear after the person's first task has finished; until then they only see the Stream.
- More about how tasks run: read the aelvyril-tasks guide.

## Quick

Ctrl+K (Cmd+K on a Mac) opens Quick from anywhere: one box that sends a message to the Stream, or finds a task by typing part of its name. With an empty box it shows a few ideas and the recent tasks.

## Settings

The gear at the top, or Settings on the home screen. Sign out is there too.

- **AI models**: connect an AI by signing in with an account (for example Claude or ChatGPT) or by pasting an API key; or add their own AI server (programs like LM Studio or Ollama, or any service that works like OpenAI's). If the app runs in Docker and the server runs on the same computer, the address uses host.docker.internal instead of 127.0.0.1. Here they also pick "The AI your new chats use" and, optionally, "AI for tasks": a different AI for tasks (for example a stronger one); "Same as chats" turns that off. They can disconnect an AI here. Keys are stored only on their computer and never shown again.
- **Extensions**: what is installed, with the ones included with Aelvyril marked (those cannot be removed). Add one by pasting a GitHub link; extensions update by themselves once a day, and "Check for updates" checks now. Extensions are programs, so only add ones from people they trust.
- **GitHub**: connect their GitHub account so coding tasks can work on their repos, see which repos it can reach, or disconnect. It may say GitHub is not set up on this Aelvyril yet.
- **Your assistant**: what you are called and what you call them, and "Back to the original look" to undo any change to the colours and layout.

To check what is connected or installed right now, call get_abilities instead of guessing.
