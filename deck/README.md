# RM Org Blueprint

`index.html` is a single self-contained page. It holds RET Media's team, what each seat
owns, the reporting lines, and the recommendation for what to change next.

## Views

- **The team**: a card per seat with its responsibilities and the accounts it works on.
  Drag any line of work onto somebody else to move it.
- **Org chart**: Garrett at the top, Olivia and Julia beneath him, and everybody who
  touches an edit reporting to Olivia. Open seats render with a dashed outline. Drag a
  card onto somebody else to change who they report to, or use the controls below the
  chart. Drag the space around the chart to pan it when it is wider than the screen.
- **Accounts**: every client with its lines of work and the owner on each one.
- **The plan**: what changed this week, an honest read on Olivia from the call, the
  changes worth making, the order to make them in, and the risks. All of it editable.

## Editing

Almost every line of text edits in place. Names, roles and tags on both the roster cards
and the chart, account names and descriptors, the title of any line of work, notes, and
everything on the plan. Click it and type. The seat editor behind the Edit button covers
the rest: layer, reporting line, colour and the locked switch.

Lines of work drag between seats from the roster. A grip appears on hover at the left of
each line, and the text itself stays clickable for editing.

## Conventions

No figures anywhere. The page reads as prose because it is meant to be read rather than
measured. No em dashes in the copy either.

A seat with no name renders as an open seat with a dashed outline on the chart. Julia's
seat is locked: her reporting control is disabled and work cannot be dragged into or out
of her card.

## Saving

Every edit writes to `localStorage` under `rm_org_blueprint_v5` as you type. There is no
save button. The menu takes a backup file and restores one.

## Keyboard

`1` to `4` switch view, `Ctrl+Z` or `Cmd+Z` undo, `Esc` closes a dialog.
