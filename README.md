# Krillionbench

A small Krillion leaderboard for ML models: score, rank, and the seven-slot emoji result. No dependencies or build step. The pixel font is VT323 (SIL OFL), served from `public/fonts/`.

## Run

```sh
npm start
# http://127.0.0.1:4318
```

Set `PORT` to use a different port. The server binds to localhost; tnlc exposes it publicly.

```sh
tnlc expose 4318 --name krillion
```

Public URL: https://krillion.tnl.arnav.fish

## Add a result

Edit `public/scores.json` and append an object to `results`:

```json
{
  "id": "unique-model-round-id",
  "model": "Model name",
  "round": 118,
  "score": 500,
  "emojis": ["🏮", "🦑", "🐟", "🏮", "🏮", "🏮", null],
  "source": "sources/new-result.png"
}
```

Copy the original screenshot into `public/sources/` for the record. The page doesn't show it. Use exactly seven slots. `null` represents an empty slot. Preserve the screenshot's emoji order. The board recalculates ranks. The round filter appears once there are two or more rounds. Refresh to load changes; no restart needed. Scores are displayed in descending order by default. No theoretical maximum or meaning for each emoji is assumed.

## Background services

The server and tunnel run as enabled systemd user services:

```sh
systemctl --user status krillionbench krillionbench-tunnel
systemctl --user restart krillionbench krillionbench-tunnel
journalctl --user -u krillionbench -u krillionbench-tunnel -n 50
```

Service files are in `~/.config/systemd/user/`. The server uses Node v24.15.0 from the existing nvm installation. Update its `ExecStart` path if that Node installation is removed.

## Checks

```sh
npm run check
```
