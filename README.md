# git-sync-watch

Watch a set of git folders and keep them in sync automatically: local changes are
committed and pushed, changes from `origin` are pulled on an interval. Single file,
zero dependencies, Node >= 14, macOS + Linux.

The syncing medium is a git remote — each machine runs its own instance and the
remote repo is where changes converge. One instance can watch any number of folders.

## Requirements

- Node.js >= 14
- `git` on `PATH` (or pass `--git /path/to/git`)
- Each watched folder must already be a git repository with an `origin` remote
  (folders without `origin` are watched locally — commits only, no push/pull)

## Quick start

```sh
# register a folder (must be a git repo)
./git-sync-watch add --watch-dir ~/Documents/My-Vault

# show what's configured (effective settings)
./git-sync-watch list

# run the daemon in the foreground
./git-sync-watch run

# install auto-start (launchd on macOS, systemd/cron on Linux)
./git-sync-watch install
```

The config file lives at `~/.config/git-sync-watch/config.ini` by default.
Override with `--config PATH` or `$GIT_SYNC_WATCH_CONFIG`.

## Commands

| Command | What it does |
|---|---|
| `add` | Register a folder to watch. Requires `--watch-dir DIR`. |
| `list` | Show watched folders with effective settings. |
| `remove` | Stop watching a folder (`--watch-dir DIR`). Config only; files untouched. |
| `run` | Run the sync daemon. `--once` = one sync pass per folder, then exit. |
| `install` | Set up auto-start: launchd (macOS) / systemd user unit (Linux) / cron `@reboot`. |
| `uninstall` | Remove auto-start. The config file is left in place. |
| `status` | Show auto-start mechanism, running state, and watched folders. |

`--help` prints the full flag reference.

### add

```
./git-sync-watch add --watch-dir DIR [--branch B] [--pull-interval N]
    [--watch-interval N] [--conflict POLICY] [--pull-after-push B] [--config P] [--git P]
```

- `--branch` — branch to sync (default: the repo's current branch)
- `--pull-interval N` — seconds between pulls (default 300)
- `--watch-interval N` — seconds between change checks (default 3)
- `--conflict POLICY` — `abort` (default) \| `remote` \| `force-local` (see below)
- `--pull-after-push B` — `true` (default) \| `false`; after pushing, do one
  immediate pull to catch changes from other machines, re-pushing if new ones arrive

## Configuration file

INI format, one section per watched folder (`watch-N` headers are renumbered
automatically on write — do not rely on them):

```ini
; git-sync-watch config
[defaults]
watch-interval = 3
pull-interval = 300
conflict = abort
pull-after-push = true

[watch-1]
path = /home/you/Vault
branch = main
pull-interval = 60
```

- `[defaults]` holds the global defaults; every key is optional.
- Per-watch keys override the defaults: `path` (required), `branch`,
  `pull-interval`, `watch-interval`, `conflict`, `pull-after-push`.
- Only keys you actually set are written to the file.
- Invalid values (e.g. `pull-interval = 0`) are ignored with a warning and fall
  back to the default; the corrected value is written on the next config write
  (the next `add` or `remove`).
- The daemon reloads the config every ~5 s — edit the file and it takes effect
  without a restart.

## How it works

Per folder, on every `watch-interval`:

1. Check for changes with `git status --porcelain` (respects `.gitignore`).
2. Changes present on two consecutive ticks get committed
   (`git-sync-watch: sync N file(s)`); `--once` commits immediately.
3. On the `pull-interval`, pull from `origin/<branch>`, then push local commits.
4. If `pull-after-push` is on, push is followed by one immediate pull so changes
   from other machines land quickly instead of waiting for the next interval.

The daemon is single-instance per machine (lock file in the temp dir; stale locks
are recovered automatically). Run it under auto-start, a process supervisor, or
`run --once` from cron for a periodic-sync setup.

### Conflict policies

| Policy | On pull/push failure |
|---|---|
| `abort` (default) | Abort the merge, restore the pre-pull tree, keep local changes. Logs an error; resolve manually. |
| `remote` | Discard local changes: `reset --hard origin/<branch>`, then push. Remote wins. |
| `force-local` | `push --force` — local wins, remote is overwritten. Use only when you know the remote is stale. |

For a multi-machine setup, `abort` is the safe default: a conflict never destroys
data, it just stops and tells you.

## Auto-start

### macOS (launchd)

`git-sync-watch install` writes `~/Library/LaunchAgents/com.git-sync-watch.plist`
and loads it. Runs at login, `KeepAlive` restarts it on crash. Logs:
`~/Library/Logs/git-sync-watch.out.log` and `.err.log`.

### Linux (systemd)

`install` writes `~/.config/systemd/user/git-sync-watch.service` and runs
`systemctl --user enable --now`. Logs: `journalctl --user -u git-sync-watch.service`.

### Linux (no systemd)

Falls back to a cron `@reboot` entry. Logs: `~/.local/state/git-sync-watch.log`.

### SSH agent sockets

`install` records the SSH agent socket (`--ssh-auth-sock PATH`, defaulting to
`$SSH_AUTH_SOCK`) in the plist/unit, because login services do not inherit it.
The path is pinned at install time and can change across reboots — if sync starts
failing with auth errors after a restart, re-run `install`. To avoid the problem
entirely, use an HTTPS remote with a credential helper (`osxkeychain` on macOS,
`libsecret` on Linux) and install without an SSH socket.

`uninstall` removes the launchd service/plist, the systemd unit, and the crontab
entry. `status` shows which mechanism is active and whether the daemon is running.

## Start, stop, restart

**Start** — `./git-sync-watch run` runs the daemon in the foreground (Ctrl-C
stops it and releases the lock). One instance per machine: a second start prints
`already running (pid N)` and exits. `run --once` does a single pass per folder
and exits, bypassing the lock — handy for cron or manual sync. For a daemon that
survives your terminal, use `install` instead.

**Stop / restart** (auto-started daemon):

| Mechanism | Stop | Restart |
|---|---|---|
| launchd (macOS) | `launchctl bootout gui/$(id -u)/com.git-sync-watch` | `launchctl kickstart -k gui/$(id -u)/com.git-sync-watch` |
| systemd (Linux) | `systemctl --user stop git-sync-watch.service` | `systemctl --user restart git-sync-watch.service` |
| cron @reboot | `pkill -f 'git-sync-watch.*run'` and remove the crontab entry | pkill, then re-run or reboot |

`./git-sync-watch uninstall` removes auto-start entirely (the config file is
kept). `./git-sync-watch status` shows which mechanism is active and whether the
daemon is running.

Notes: launchd runs with `KeepAlive`, so a plain `kill` is followed by an
automatic restart — use `bootout` to stop it. systemd's `Restart=on-failure`
only restarts on failure, so `systemctl stop` stays stopped. A SIGKILL'd daemon
leaves a stale lock file; it is detected and removed automatically on the next
start.

## Example: sync an Obsidian vault across computers

Goal: the same vault, edited on a laptop and a desktop, converging through a
private git remote — no cloud sync service, no Obsidian Sync.

### 1. Create the remote

A private repo on GitHub/GitLab/any git host, e.g. `obsidian-vault`.

### 2. Machine A — macOS

```sh
# clone the remote into your vault folder (or init an existing vault, commit,
# add the remote, and push once: see "existing vault" below)
cd ~/Documents
git clone git@github.com:you/obsidian-vault.git "Obsidian Vault"

# register it
./git-sync-watch add --watch-dir "$HOME/Documents/Obsidian Vault"

# sync quickly (default pull is every 300 s; 60 s feels live)
./git-sync-watch add --watch-dir "$HOME/Documents/Obsidian Vault" --pull-interval 60

# install auto-start
./git-sync-watch install --ssh-auth-sock "$SSH_AUTH_SOCK"
# or, with an HTTPS remote + keychain helper (no socket to pin):
#   git config --global credential.helper osxkeychain
#   ./git-sync-watch install

./git-sync-watch status
```

### 3. Machine B — Linux

```sh
cd ~
git clone git@github.com:you/obsidian-vault.git Vault

./git-sync-watch add --watch-dir "$HOME/Vault" --pull-interval 60
./git-sync-watch install      # reads $SSH_AUTH_SOCK automatically
systemctl --user status git-sync-watch
```

Each machine keeps its **own** config file (paths differ); the git remote is the
sync medium, so both daemons can run at once.

### 4. Ignore per-machine Obsidian state

Obsidian writes device-specific UI state that changes constantly and causes
merge noise. Add this to the vault's `.gitignore` (it applies on all machines):

```gitignore
.obsidian/workspace.json
.obsidian/workspace-mobile.json
.obsidian/cache
```

Everything else — notes, attachments, plugins, settings in `.obsidian/` — syncs
normally, including deletions (`git add -A` tracks them).

### 5. What to expect

- A note edited on A is committed within ~6 s, pushed, and pulled on B within
  `pull-interval` (or right after B pushes its own changes, via `pull-after-push`).
- Conflict policy `abort` (default): if you edit the same note on both machines,
  the merge is aborted and both sides keep their local versions. The daemon logs
  an error; resolve by hand (edit one copy, `git commit`, `git pull`). Nothing
  is silently lost.
- `git-sync-watch run --once` does a single pass over every folder and exits —
  handy for a manual "sync now" or a cron-based alternative to the daemon.

### Existing vault (no clone)

```sh
cd /path/to/vault
git init && git add . && git commit -m "initial"
git remote add origin git@github.com:you/obsidian-vault.git
git push -u origin main
# then: git-sync-watch add --watch-dir /path/to/vault
```

## Troubleshooting

- **`already running (pid N)`** — a daemon is already running for this machine;
  that is expected under auto-start. `--once` bypasses the lock.
- **`conflict — resolve manually or git reset --hard origin/<branch>`** —
  a pull hit a merge conflict under the `abort` policy; the pre-pull tree was
  restored. Resolve in the folder, commit, and the daemon picks it up.
- **Push/pull disabled for this folder** — no `origin` remote was detected at
  loop start; commits still happen. Add the remote and restart the daemon
  (or rewrite the config file) so it re-detects.
- **Auth errors after reboot** — the pinned SSH agent socket path changed;
  re-run `install`, or switch to an HTTPS remote with a credential helper.
- **Daemon logs** — launchd: `~/Library/Logs/git-sync-watch.{out,err}.log`;
  systemd: `journalctl --user -u git-sync-watch.service`;
  cron: `~/.local/state/git-sync-watch.log`.

## Development

```sh
node --test git-sync-watch.test.js   # unit tests for the exported functions
node --check git-sync-watch          # syntax check
```
