# Example run

The real, unedited output of one exploration of a practice shopping application,
committed so the artefact can be read without installing anything. This is the
newer of the two runs under `examples/`; the other one, against a deliberately
buggy practice site, is older and says so about itself.

| | |
|---|---|
| Target | `https://www.saucedemo.com/` — Swag Labs, Sauce Labs' public practice shop |
| Model | `qwen2.5:14b`, local, on an AMD RX 6900 XT |
| Budget | 14 steps |
| Result | **2 findings**, 2 pages reached, 7 notes, `step-limit` |

## What the run actually does

It logs in. Step 1 reads the form, steps 4 and 5 type `standard_user` and
`secret_sauce` into it, step 6 presses Login, and step 7 lands on the inventory page
with twelve actionable refs in the shortlist. Then it finds the `Sort products`
combobox, clicks it three times, watches the console error count go up, and runs out
of budget.

Compared with the older example, that is progress: a real journey with real steps
rather than a single page read repeatedly. The shortlist is doing its job in the
path - `e11`, `e13`, `e15`, `e38` are refs the harness read off the page.

## The two findings are the same two numbers

Both of them come from the console counter in the snapshot header:

```
step 3   - Console: 1 errors, 0 warnings   -> "Console error on login page"        (low)
step 14  - Console: 5 errors, 0 warnings   -> "Console errors after clicking the sort dropdown"  (medium)
```

The agent never called `browser_console_messages` in this run. Not once. So it
reported a number it could see without ever looking at what the number was counting,
and it has no answer to the only question that matters for either finding: what
broke? The medium severity - "degrades a task" - is not supported by anything in the
transcript.

That is a failure mode worth naming, because the harness cannot guard it with the
rule it already has. The prompt says to read the console at most once per page and
never to report third-party noise as a finding on its own; both rules assume a step
is spent reading the console, and a token that is never spent cannot be regulated.
The counter in the header is an invitation to report without looking, and this run
accepted it twice.

## What is still bad in it

- **Three clicks on a native select.** Steps 9, 11 and 13 click the same combobox,
  and the options never appear in a snapshot, because a native `<select>` does not
  render its options into the page until the browser opens them. The prompt says in
  plain words to use `browser_select_option` for a select box and that repeating the
  click will loop forever. This run is what that cost before the harness took the rule
  over: a quarter of the budget, spent to learn that the sort dropdown has four
  options - which `browser_find` had already told it at step 8. The loop refuses the
  second click on a select box now, so a run made today would lose one step to this
  instead of four.
- **Two pages of the application.** Login, inventory. No product, no cart, no
  sorting, no checkout. The coverage section says so, which is the point of the
  coverage section.
- **The widening nudge changed nothing.** It fired at step 4 ("only 1 page(s) reached
  after 4 steps") and the run still ended on two pages. Four runs against the older
  example's target did the same thing, each ending on two pages of twelve. Since this
  run, three steps of that is all the nudge gets: the loop then navigates back to the
  start page itself, and records the step as `overridden`.
- **The guide is thinner than the run.** Seven notes for fourteen steps, four of them
  about the existence of the login form. That is honest, and it is not a guide anyone
  would use to understand this application.

## Files

| File | What it is |
|---|---|
| `findings.md` | the two findings above, with the coverage section |
| `app-guide.md` | what the run established, and the path it took |
| `run.jsonl` | one JSON object per step: tool, args, result preview, and why each note was kept, trimmed or dropped |
| `summary.json` | counts, stop reason, and the prompt version that produced them |
