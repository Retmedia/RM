# RM Org Blueprint

`index.html` is a single self-contained page. It holds RET Media's team, what each seat
owns, the reporting lines, and the recommendation for what to change next.

## Views

- **The team**: a card per seat with its responsibilities and the accounts it works on.
  Drag any line of work onto somebody else to move it.
- **Org chart**: Garrett at the top, Olivia and Julia beneath him, and everybody who
  touches an edit reporting to Olivia. Redraws from the reporting controls below it.
  Open seats render with a dashed outline.
- **Accounts**: every client with its lines of work and the owner on each one.
- **The plan**: what changed this week, an honest read on Olivia from the call, the
  changes worth making, the order to make them in, and the risks. All of it editable.

## Conventions

No figures anywhere. The page reads as prose because it is meant to be read rather than
measured. No em dashes in the copy either.

A seat with no name renders as an open seat with a dashed outline on the chart. Julia's
seat is locked: her reporting control is disabled and work cannot be dragged into or out
of her card.

## Saving

Every edit writes to `localStorage` under `rm_org_blueprint_v4` as you type. There is no
save button. The menu takes a backup file and restores one.

## Keyboard

`1` to `4` switch view, `Ctrl+Z` or `Cmd+Z` undo, `Esc` closes a dialog.
