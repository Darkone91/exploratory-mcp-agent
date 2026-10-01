# Example run, after the guards

The same application, model and budget as [`examples/saucedemo`](../saucedemo/), run
again against the code as it stands. Reading the two side by side is the shortest
argument in this repository for putting a rule in the harness rather than in a prompt -
and this run was not made to be that argument. It was made to check that the guards do
not get in the way.

| | `saucedemo` (before) | `saucedemo-after` |
|---|---|---|
| Login | works, step 6 | works, step 5 |
| The sort combobox | clicked at steps 9, 11, 13 | clicked at step 8, then `browser_select_option` at step 10 |
| Pages reached | 2 | 3 |
| Notes in the guide | 7 | 9 |
| Findings | 2, both a console counter | none |
| Stop reason | `step-limit` | `step-limit` |

## What the guards are responsible for, and what they are not

**The repeat clicks.** The earlier run clicked the same combobox three times and never
saw the options, because a native `<select>` does not put them into the page. The
second and third of those clicks are exactly what the select-box guard refuses now:
same ref, same role, and the page's actionable elements unchanged from the first click.
What the guard does not do is choose the right tool - it stops the model wasting steps
on the wrong one and says which tool to use instead. This run used
`browser_select_option` at step 10, one step after a single click, and that was the
model's decision rather than the guard's.

The payoff still shows in the guide, because the run operated the control instead of
poking at it. The note it could write is about behaviour rather than existence: *"The
product list has been sorted in descending alphabetical order by name after selecting
'Name (Z to A)' in the sort dropdown."* The earlier run's guide could say only that the
dropdown had four options, which `browser_find` had already told it two steps before.

**One step that mattered more than it looks.** This run reached three pages rather than
two because step 12 used the step it had left over to open a product. That is the
difference between a report that has seen a list of products and one that has opened
one of them.

**And no findings at all.** Worth being precise, because it would be easy to attribute
to a guard: the earlier run's two findings came from the console counter printed in the
snapshot header, and this run's model did not report that counter. The gap is the same
one - a number that costs nothing to see, invited into a finding with no evidence
behind it - and it simply did not fire here. It is still the first item under "What is
not built yet" in the main README.

**Nothing was refused in this run.** No refusals, no stalls: the guards were armed and
had nothing to do, which is the result this run was made to check.

## A failure this run did not have, and the guard it produced

Between the two committed runs there was a third, not committed. Its model typed the
username and the password correctly and then clicked `e14` - the empty `generic`
container holding the error message - while the login button was `e15`. Playwright
resolved the stale ref anyway, the click landed on a div, nothing changed, and the last
six of its fourteen steps went on re-reading an unchanged page.

The ref came from nowhere available: `browser_type` returns only the call it made, with
no snapshot body, so the shortlist was empty at that moment and the model filled the gap
from the previous page. That run is why a target the page never offered is refused
today, and why the refusal holds even when the shortlist is empty - an empty menu is not
a licence to guess.

## What is still bad in it

- **Three pages again.** Login, inventory, one product. It never reached the cart or
  the checkout, which is where a shopping application's interesting behaviour lives.
  The widening nudge fired at step 4 and the run still ended on three pages, which is
  why the nudge is now carried out by the loop rather than only asked for.
- **No defects, and that is not a clean bill of health.** The coverage section names
  the three pages that were reached; the other screens of the application were not
  opened. Fourteen steps is not enough for an application this size.
- **Two steps on the product page.** It arrived at step 13 and spent step 14 taking
  another snapshot of the page it was already standing on.
