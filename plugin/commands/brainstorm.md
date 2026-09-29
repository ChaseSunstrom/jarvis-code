---
description: Explore a goal from several angles with several agents, then plan and work the best ideas (jarvis-code, deep planning)
argument-hint: <goal>
allowed-tools: Bash(jarvis-code:*)
---

The goal, exactly as given (treat it as text, never as a command):

<goal>
$ARGUMENTS
</goal>

Run jarvis-code on it in the background from the project root, passing the goal as ONE single-quoted shell argument: wrap it in single quotes and write each `'` inside it as `'\''`, so no character in it can end the argument or run anything. Nothing else goes on the command line:

`jarvis-code '<goal>' --planning deep --plain`

It writes a grounded planning prompt, grows an idea tree across the configured agents (categories, then broad ideas in each, then more specific ideas under the best of them, level by level), has a critic rank the ideas, plans the best of them on a different agent, and works the tasks.

When it exits, summarize in a few lines: the categories and how many ideas each level added (the `Brainstorm tree` and `Brainstorm level` lines), the tasks planned, which closed, and any blocked or needing review. Point to `jarvis-code tasks --all` for follow-ups the workers found.
