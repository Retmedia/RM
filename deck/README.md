# RM Org Blueprint

`index.html` is a single self-contained page — RET Media's roster, deliverables and
reporting lines, with my recommended restructure sitting next to the current one.

## The switch

Everything on the page reads from a **Today / Proposed** toggle in the header (or press `P`).
Roster loads, the org chart, account owners and every headline number recompute against
whichever scenario is selected, so the two structures are the same page rather than two
documents.

## Views

- **Roster** — a card per seat: role, reporting line, direct reports, pay, weekly load
  against capacity, and every deliverable they own grouped by account. Drag any deliverable
  onto another person to move it. In Proposed, moves are stored separately, so the "today"
  picture never changes underneath you.
- **Org chart** — redraws from the reports-to controls beneath it. Seats cut in the proposal
  disappear from the proposed chart.
- **Accounts** — the delivery contract per client, with the owner and hours on every line.
- **The plan** — the recommendation: eight moves with reasoning and impact, a sequence, and
  the risks. Fully editable.
- **Weekly output** — the original distribution tables.

## The model

Every deliverable carries an estimated **hours a week**. A person's load is the sum of what
they own; capacity is per seat and editable. There is no scoring or task tracking — the
hours exist to answer one question: does this seat justify a hire.

Totals are conserved across scenarios — 118.5 hours either way. The proposal redistributes
work, it does not add or remove any.

## Locked seats

A seat can be marked **Locked** in its editor. Julia is locked: her scope, reporting line and
pay are identical in both scenarios, her reports-to control is disabled, and deliverables
cannot be dragged into or out of her card.

## Saving

Every edit writes to `localStorage` under `rm_org_blueprint_v1` as you type — per browser,
no save button. ⋯ → *Download backup* takes a `.json`; *Restore from backup* loads one.

## Keyboard

`P` toggle scenario · `1`–`5` switch view · `⌘/Ctrl+Z` undo · `Esc` close
