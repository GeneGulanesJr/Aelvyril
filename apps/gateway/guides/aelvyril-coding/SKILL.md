---
name: aelvyril-coding
description: Coding projects in Aelvyril - making a project from a GitHub repo or from nothing, the isolated sandbox a coding task works in, showing the app in the preview window, and asking the person to publish (you cannot push yourself). Read it before any work on code, a repo, an app or a website, or when the person asks how coding works.
---

# Coding projects

Say "task", never "job". Do not name tools to the person.

## Is it available?

Coding projects need a sandbox service that is not part of every install. list_projects (or get_abilities) says whether they are set up on this computer. If not, tell the person plainly that coding projects are not set up on this Aelvyril.

## Making a project

- All work on the person's code happens in a project. First call list_projects: if a project for that code exists, reuse it; otherwise create_project.
- A project is either a copy of one of the person's GitHub repos (given as owner/name) or a new, empty one. A repo only works if GitHub is connected in Settings and the Aelvyril GitHub app can see that repo.
- Then start a task with start_job and the project's id. Never ask a task without a project to change code in a repo.
- Each project shows as a card on the home screen.

## The sandbox

- Each project lives in its own isolated sandbox: a Linux container with Node, Python and git. It can reach the internet, and it holds no secrets.
- The code is on a git branch made for this work, and the task commits as it goes. Its reading, writing, editing and commands all run inside the sandbox, never on the person's computer.
- The person's GitHub login stays with Aelvyril itself and never goes into the sandbox.
- A coding task does not get the helpers that split big tasks, or the script tool other tasks have.

## Showing the app

The task can start the project's app (run_app) so the person can see it in a preview window: they open it from the project card ("Open preview"). The preview window has Reload and Log buttons. On the card the person can also Start or Stop the sandbox, Run app or Stop app, see how much CPU, memory and disk it uses, and delete the project and its sandbox for good.

## Publishing

When the work is committed and checked, the task asks to publish (request_push) with a pull-request title and description. You cannot push by yourself: the person sees "Ready to publish" and a "Push and open PR" button on the project card, and only their tap pushes the branch to GitHub and opens the pull request. A link to it then shows on the card.
