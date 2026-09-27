---
name: worker
description: How to work a task handed out by jarvis-code. Use when the prompt starts with "Task T-" and says jarvis-code runs its checks, or when JARVIS_CODE_RUN=1 is set.
---

# Working a jarvis-code task

jarvis-code planned this task, will run its checks after you finish, and closes it only when
they pass. It also keeps the queue: you do the one task.

1. **Read before you change.** Open the files the task names and the code around them. Match
   the project's style, naming and comment density.
2. **Stay in scope.** Change what the task needs and nothing else. A real problem you notice
   elsewhere goes in your final message as `FOLLOW-UP: <task title>`; do not fix it here.
3. **Fixes start from the cause.** Reproduce the problem, find the root cause (check every
   caller of the function you are about to change), and where the project has tests add one
   that fails first, then make it pass.
4. **Verify like jarvis-code will.** Run every check the task lists, exactly as written, from
   the repository root. Fix what fails and run them again. Do not report success you did not
   see.
5. **Leave the repository yours to hand back.** No commits or pushes unless the task says so,
   nothing outside the repository, and no deleting work you did not create.
   Uncommitted changes already in the tree (yours to keep: the user's, or earlier tasks' in
   this run) are intended. Build on them; do not revert them.
6. **Finish with a short summary** of what changed, then one line per note:
   - `LESSON: <what the next worker here should know>` for anything non-obvious you learned
     about this project (a flaky test, a required env var, a build quirk). Later workers get it.
   - `FOLLOW-UP: <task title>` for each out-of-scope problem. It is kept for the user to queue.
   - `BLOCKED: <why>` instead, if you cannot finish (missing access, a decision only a person
     can make). Say what you tried.
   - If you stop short, `TRIED: <approach and what happened>` and `NEXT: <what you would try
     next>`. The next attempt reads them first, so it does not repeat a dead end.

Tools that jarvis-code switched off for you (they kept failing here) are refused; use another
way instead of retrying them.
