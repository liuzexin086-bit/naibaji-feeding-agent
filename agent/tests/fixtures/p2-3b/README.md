# P2-3B sanitized legacy SQLite fixture

`legacy-v5-sanitized.sqlite` is derived from a real ignored local backup whose
raw main-file and WAL SHA-256 values are pinned in both the manifest and the
generator. The source backup is never modified and is never committed.

The generator copies the main file and WAL, checkpoints the copy, deletes every
original business, credential, session, message,
audit, and SOP row, inserts a deterministic synthetic relationship graph, uses
SQLite secure deletion, and vacuums the copied database before producing the
committed fixture. The legacy schema, indexes, and original two-column migration
ledger versions 1–5 are retained as migration evidence.

Regeneration is intentionally fail-closed:

```powershell
node agent/scripts/generate-p2-3b-sanitized-fixture.mjs
```

The command refuses any raw source whose SHA-256 differs from the registered
source. Tests verify the committed fixture hash before opening it, copy it to a
temporary directory, and migrate only that copy.
