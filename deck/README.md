# RM Dispatch Deck

`index.html` is a single self-contained page — the RET Media org breakdown rebuilt as a
live work board. Open it directly in a browser, or use the published artifact.

## What's in it

- **Board** — every deliverable as a card moving through Queue → In progress → QC → Shipped.
  Group by stage, by person, or by account; drag cards to move, reassign, or reallocate them.
- **Roster** — the team with weekly targets, banked points, levels and badges, plus a
  this-week leaderboard.
- **Accounts** — the delivery contract per client. Any line can be pushed onto the board.
- **Weekly output** — the reference distribution tables, editable cell by cell.
- **Org chart** — redraws from the "reports to" controls underneath it.

## Points and the weekly reset

Each card carries a point value. Shipping a card banks those points to its owner, feeding
their level and the team meter. A person's weekly target defaults to the sum of the points
they own; set a number in their editor to override it.

When the ISO week rolls over the deck archives the week into history, resets everyone's
weekly count, moves recurring shipped work back to the queue (monthly work waits for the
month to turn), and extends or breaks the team streak.

## Saving

Every change writes to `localStorage` under `rm_dispatch_deck_v1` — per browser, no save
button. Use ⋯ → *Download backup* to take a `.json` file and *Restore from backup* to load
one on another machine.

## Keyboard

`/` search · `N` new work · `1`–`5` switch view · `⌘/Ctrl+Z` undo · `Esc` close
