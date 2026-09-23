# Example run

The real, unedited output of one exploration, committed so you can read what the
agent produces without installing Ollama, Playwright and a 14B model first.

| | |
|---|---|
| Target | `https://the-internet.herokuapp.com/` — a public site of deliberately buggy practice pages |
| Model | `qwen2.5:14b`, local, on an AMD RX 6900 XT |
| Budget | 14 steps |
| Result | **0 findings**, 3 pages reached, `step-limit` |

## Start with `findings.md`

It reports no defects, and that is the part worth reading. A run that finds nothing
and a run that *looked* at nothing produce identical files unless the report says
what it covered, so it says so:

> No defects were observed in this run.
>
> Read that with the coverage below in mind: 14 steps reached 3 pages.
>
> - https://the-internet.herokuapp.com/
> - https://the-internet.herokuapp.com/abtest
> - https://the-internet.herokuapp.com/checkboxes
>
> Pages that were never opened are not evidence of health.

The application has twelve linked example pages. Three were opened. So this report
is not a statement that the application is healthy, and it now refuses to look like
one.

That matters more than a screenshot of a bug list, because a tool that overstates
what it examined is worse than no tool. The same instinct shows up in `run.jsonl`,
which keeps the raw evidence behind every claim: when a report looks wrong, the
first question is always what it actually saw.

## Then `app-guide.md`

Two parts. `Pages reached` is machine-gathered from what the browser loaded, not
from what the model said it did. The notes beneath it are the model's own summary of
each step, and there the checkboxes trail is a fair picture of what this is good at:

> The Checkboxes page contains two checkboxes and a paragraph describing the purpose
> of the page.
>
> The first checkbox is now checked after clicking it.
>
> The second checkbox is now unchecked after clicking it.

That is a usable behavioural description of a page, built without anyone writing a
test for it.

It is also only about half the notes. The rest are narration rather than
observation - "Navigating back to the homepage to explore another link" tells a
reader nothing they could act on. Tightening that is the next piece of work, and it
is written up in the parent README as a known gap rather than tidied away here.

## `run.jsonl`

One JSON object per step: the tool called, the arguments, what the model wrote
down, timings and token counts, and a preview of what the browser returned. This is
the file that settles arguments.

## `summary.json`

Counts and the stop reason. `distinct pages reached` is the number quoted in
`findings.md`.
