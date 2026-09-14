# @gmbl/gm-stats

Statistics core for slot simulation runs: win-distribution buckets, aggregation, merging of
parallel shards, run manifests, config hashing, and an HTML run panel.

TypeScript, zero runtime dependencies, `node --test`.

## What it does

- **`buckets`** — win-distribution ladder (multiples of bet) with per-bucket share and its
  contribution to total RTP in percentage points.
- **`aggregate` / `accum`** — per-mode and per-round accumulation: rounds, wagered, wins, hit
  rate, max win, volatility.
- **`mergeStats`** — merges shards from parallel runs under explicit merge rules, so a run split
  across workers gives the same numbers as a single-threaded one.
- **`configHash`** — a stable hash of the configuration a run was made with. Numbers from
  different configs must never silently end up in the same table.
- **`statsPanelHtml` / `statsPanelInfo`** — a run panel rendered by the core, not by the host.
- **`SheetPort`** — a narrow port (Apps Script / HTTP / in-memory) so the core does not know where
  the table lives.

## What it deliberately does not do

It does not know the game. Bucket ladders, mode names and row composition come in as
configuration; the package computes and formats, it does not decide what a mode is.
