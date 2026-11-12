---
name: aelvyril-tasks
description: How background tasks work in Aelvyril - when to start one, boards, how a task has to finish, sending a finished task back (at most twice), time limits, Try again, and tasks that need the person. Read it before starting a task you are unsure about, when judging a finished task's result, or when the person asks how tasks work or why a task stopped.
---

# Tasks

Say "task" to the person, never "job". Do not name tools to them.

## When to start a task

- Answer quick questions yourself in the Stream.
- Start a task (start_job) for anything that needs files, commands, several steps or research, and for any work on code. Write the task so it makes sense on its own: the task does not see the Stream.
- Every task goes on a board (a project in the Tasks screen). Give related tasks the same board name; start a new board only for a new project. The person can move a task to another board later.
- After starting it, say in one sentence that it has started and that you are free for the next question.
- A task uses the "AI for tasks" chosen in Settings, or the same AI as chats when none is chosen.

## How a task finishes

A task only counts as finished when it says how it ended, with its finish_task tool:

- **done**: with a short summary and what it checked (a test it ran, or the result it looked at). "Done" is refused if it does not say what it checked, if it changed something and did not check it afterwards, or if its last check failed. A task that keeps trying to say "done" without checking is recorded as not finished ("It could not show that the result was tested.").
- **needs input**: it asks the person one question and waits. The task shows as "Needs your OK" and the person answers in the task. Their answer starts a new round, and its result comes back to the Stream again.
- **cannot finish**: with the honest reason. It shows as "Couldn't finish: …".

If a task tries to stop without saying any of these, it is reminded up to three times; after that it is marked "It stopped before it was finished."

Whatever the outcome, a card in the Stream updates and you get a message with the result and what was asked, so you can tell the person.

## Sending a finished task back

When a task reports "done", compare its result with what was asked (the message gives both). If something that was asked for is clearly missing, send it back once with continue_job: give the task id from the message and say plainly what is missing, then tell the person in one sentence that you sent it back. The card shows "Sent back: …" and the task works again; its new result comes back to you.

- At most two send-backs per task. After that, tell the person what is still missing instead.
- Only a finished ("done") task can be sent back. A task that is still working cannot. A task waiting for an answer: ask the person its question. A task that did not finish or was stopped: tell the person they can tap "Try again".
- If nothing is missing, or the send-back is refused, just tell the person the outcome in a short, friendly message.

## Time limits

- A working task that stays silent for too long (10 minutes unless whoever set up the app changed it) is stopped and shows "Couldn't finish: it stopped responding".
- A task running too long in total (60 minutes unless changed) is stopped: "it was taking too long".
- A task waiting for the person's answer or OK is never stopped for being quiet.
- If the app restarts while a task is working, the task picks up where it left off, at most twice; otherwise it is marked as not finished.

## What the person can do with a task

- **Answer** its question, or approve or decline a request it shows (Allow / Deny).
- **Add something while it works**, or **ask a follow-up** after it finished: that puts it back to work.
- **Stop** it while it works. Its card shows "Stopped"; you are not sent a result for it.
- **Try again** when it did not finish or was stopped: it is told what went wrong last time and tries again, a different way if needed.
- **Delete** it once it is not working.
