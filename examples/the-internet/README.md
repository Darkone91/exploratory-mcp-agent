# Example run

The real, unedited output of one exploration, committed so you can read what the
agent produces without installing Ollama, Playwright and a 9 GB model first.

This is the older of the two runs under `examples/`. `examples/saucedemo` is newer,
and was produced by the code as it stands; this one was not, and the last section
below is the list of changes that postdate it.

| | |
|---|---|
| Target | `https://the-internet.herokuapp.com/` — a public site of deliberately buggy practice pages |
| Model | `qwen2.5:14b`, local, on an AMD RX 6900 XT |
| Budget | 14 steps |
| Result | **1 finding**, 2 pages reached, `model-finished` |

## `findings.md` — and why the finding is probably wrong

One finding: right-clicking the box on the Context Menu page does not open a context
menu. The agent is right about what it saw and wrong about the application. That menu
is drawn by the browser, not by the page, so it can never appear in an accessibility
snapshot. The agent did the only thing it could do - it looked, saw nothing, and
reported that nothing happened. A human testing this page would call it a bug in the
tool.

That is worth reading as the headline rather than as an embarrassment. The
alternative - a tool that reports confident findings you have to double-check - is
what the whole project is built to avoid, and a finding that describes its own
evidence is at least actionable. It is also why the file opens with *"treat them as
leads to reproduce, not as confirmed defects"*.

## `app-guide.md` — the part that got better

Roughly half the notes in an earlier example were the agent narrating its own
intentions: *"The homepage contains a link to 'Checkboxes' which I am about to
click."* Those are now trimmed off, and what is left is statements about the
application:

> The page contains instructions to right-click a box to open a context menu.
>
> The page instructs to right-click in the box to open a context menu, but the action
> did not produce any visible change or menu.
>
> The page instructs to right-click in the box below to see a context menu item called
> 'the-internet'; attempting to verify this action.

The second and third lines are the interesting ones. The page *claims* a context menu
will appear. An earlier version of this agent reported that the menu did appear - it
had copied the page's own instructions and presented them as an observation. Now it
says what it can support: the page instructs this, and the instruction was not
confirmed. That distinction is the point of the project.

## What is still bad in it

Read "Path taken" and you can watch the agent struggle. Steps 8 and 11 are marked
**failed**: it asked to click refs `e2` and `e12`, which never existed. It had just
navigated, Playwright returned the snapshot as a file link rather than inline, so the
shortlist was empty and the model filled the gap by inventing refs - precisely what
the prompt tells it not to do, and the cost was two of fourteen steps.

That is fixed now, and this run is the reason the fix has the shape it does. A ref the
page never offered is refused before it is used, with the list of refs that would work
and an instruction to take a snapshot. It is not the same fix as refusing an empty
shortlist outright, because of something a later run showed: `browser_type` returns no
page at all, so an eager version of this guard wiped the refs between the username and
the password and refused the second keystroke. Refs now survive a fill and die at a
navigation.

Seven of the thirteen steps went into one page, and it reached 2 pages of a
twelve-page application. That is poor coverage, and the report says so rather than
implying otherwise.

Both are next on the list. The second is why the loop counts distinct pages reached
and pushes the model to widen when that count stays low - and that push, being a
paragraph of prompt, was ignored by six runs in a row, so three steps of silence now
means the loop goes back to the start page itself.

## One thing that postdates this run

Several changes are newer than the run committed here, so its own files do not show
them:

- Coverage now appears as its own section in `findings.md`, on every run rather than
  only on runs that found nothing, so this `findings.md` does not have it.
- `run.jsonl` gained `noteKept`, `noteIssue` and `refused`, the fields that let a
  transcript explain why a note was trimmed, dropped, or never a note to begin with -
  and why a step produced nothing. A transcript from before them, like this one,
  records what the model said and nothing about what happened to it.
- Notes are de-duplicated by content rather than by exact match, and a note written
  from inside the run ("the current page contains...") is dropped. Five of the eight
  lines in this run's `app-guide.md` are restatements of one claim about the context
  menu, and the current code would keep one of them.
- Two guards in the loop are newer than this run as well: a repeat click on a select
  box is refused, and a widening nudge that goes unanswered for three steps is
  carried out by the loop itself. Neither would have changed much here - this run
  never touched a select box, and it did travel to a second page - but they are two
  more reasons the numbers would differ if it were run today.
- A ref the page never offered is refused, which is this run's own two failed steps:
  `e2` and `e12` would never have been sent to the browser. So would a run that stops
  itself after five identical results, which this one did not reach, since its failures
  at least produced different text each time.

`npm test` covers what the current renderer and recorder produce.
