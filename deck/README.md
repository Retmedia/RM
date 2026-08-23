# RM Org Blueprint

`index.html` is a single self-contained page. It holds RET Media's team, what each seat
owns, the reporting lines, and the recommendation for what to change next.

## Views

- **The team**: a card per seat with its responsibilities and the accounts it works on,
  grouped by who each person reports to so it always matches the chart. Drag any line of
  work onto somebody else to move it.
- **Org chart**: two editors at the bottom, a Senior Editor over them, Olivia over that,
  Julia off to the side, Garrett at the top. Open seats render with a dashed outline. Drag a
  card onto somebody else to change who they report to, or use the controls below the
  chart. Drop a card into the gap beside another card to sit next to them instead of
  under them, which is how siblings get reordered. Drag the space around the chart to pan
  it when the chart is wider than the screen.
- **Accounts**: every client with its lines of work and the owner on each one.
- **The plan**: what changed this week, an honest read on Olivia from the call, the
  changes worth making, the order to make them in, and the risks. All of it editable.

## Editing

Almost every line of text edits in place. Names, roles and tags on both the roster cards
and the chart, account names and descriptors, the title of any line of work, notes, and
everything on the plan. Click it and type. The seat editor behind the Edit button covers
the rest: layer, reporting line, colour and the locked switch.

Dragging and editing share the same text. Click a line to edit it, drag the same line to
move it. The rule is that an unfocused line drags and a focused one selects text, so a
click always edits and a pull always moves. Lines of work also show a grip on hover.

## Conventions

No figures anywhere. The page reads as prose because it is meant to be read rather than
measured. No em dashes in the copy either.

A seat with no name renders as an open seat with a dashed outline on the chart. Julia's
seat is locked: her reporting control is disabled and work cannot be dragged into or out
of her card.

## Saving

Every edit writes to `localStorage` under `rm_org_blueprint_v6` as you type. There is no
save button. The menu takes a backup file and restores one.

## Keyboard

`1` to `4` switch view, `Ctrl+Z` or `Cmd+Z` undo, `Esc` closes a dialog.
