# screencast_scripts

Infrastructure for recording herbstluftwm screencasts narrated live by an
OpenCode agent. Plain markdown scripts drive the recording; the agent reads
prose aloud into a floating narration window and silently performs the
operations described in code blocks.

## Components

| File | Purpose |
|---|---|
| `bin/screencast-shell` | Bash wrapper enabling remote agent delegation. Run it via alacritty; it binds the terminal to a persistent tmux session running an interactive bash. |
| `bin/screencast-narration` | Display wrapper for the agent narration window (follows the narration log). |
| `bin/screencastctl` | The agent-facing control CLI (spawn/send/run/read/say/clear/key/status). |

Both wrappers are launched through `screencastctl spawn`, which registers a
one-shot herbstluftwm rule (`floating=on focus=on`) and spawns alacritty via
`herbstclient spawn`. Closing the terminal only detaches; the tmux session
and its history survive, and re-running the wrapper re-attaches.

## The two windows

**Narration window (read window)** — floating pane running `tail -f` over
`${XDG_RUNTIME_DIR:-/tmp/opencode}/screencast/narration.log`. The agent
writes paragraphs with `screencastctl say`, verifies what the audience sees
with `screencastctl read narration`, and wipes both with
`screencastctl clear narration`.

**Delegation shell (write window)** — floating pane running bash with a
distinctive `[screencast]` prompt. The pane title toggles `running` while a
command executes and `idle` at every prompt, which is how remote callers
detect completion. The agent delegates with `send` (type + Enter), `run`
(send, wait for idle, return only the new output), and `key` (raw keys such
as `C-c`).

## screencastctl reference

```
screencastctl spawn   [narration|command] [session]   # floating window via herbstclient
screencastctl ensure  [narration|command] [session]   # detached session, no window
screencastctl send    [command] <text>                # type text + Enter
screencastctl run     [command] <cmd>                 # send + wait idle + new output
screencastctl read    [role] [--lines N]              # capture pane incl. scrollback
screencastctl say     <text...>                       # append narration paragraph
screencastctl clear   [role]                          # wipe screen + history
screencastctl key     [command] <keysym...>           # raw keys, e.g. C-c
screencastctl hlwm    <args...>                       # silent herbstclient ops
screencastctl attrjson <object-path>                  # attr tree as JSON
screencastctl status
```

Roles: `narration` (aliases `narr`, `read`) and `command` (aliases `cmd`,
`shell`, `write`). A raw tmux session name is also accepted.

Environment overrides: `SCREENCAST_CMD_SESSION`, `SCREENCAST_NARR_SESSION`,
`SCREENCAST_RUN_TIMEOUT` (default 15s), `SCREENCAST_CMD_GEOM`,
`SCREENCAST_NARR_GEOM` (herbstluftwm floating geometry, e.g.
`1100x620+1380+760`).

## Screencast script format

Scripts are plain markdown, parsed by the agent (see the `/screencast`
command once the plugin is installed):

1. **Prose paragraphs** are narration. The agent displays each paragraph in
   the narration window via `screencastctl say`, one at a time.
2. **Fenced code blocks tagged `bash`** (or `sh`) are commands the agent
   delegates into the visible delegation shell via `screencastctl run`.
3. **Fenced code blocks with any other tag** (`hlwm`, `pseudocode`, ...) are
   herbstluftwm operations expressed as `herbstclient` arguments. The agent
   executes them directly with herbstclient and must **never** display them.
4. **A line consisting of a single inline code span** — `` `sleep 2s` `` or
   `` `sleep 500ms` `` — is a directive to idle before reading the next
   paragraph. Nothing is displayed.

### Example

```markdown
Welcome to herbstluftwm. In this segment we look at manual window placement.

`sleep 2s`

```hlwm
add demo
spawn alacritty
```

A new workspace and terminal have been created. Now the terminal moves.

```hlwm
move demo
```

And the move is visible: the window left the former workspace. On the shell
side, the same layout can be inspected non-interactively:

```bash
herbstclient layout
```

`sleep 1s`
```

## Testing notes (verified on tmux 3.6 / herbstluftwm)

- `run` completion detection is title-based (`idle`/`running` OSC 2 from the
  rcfile DEBUG-trap/PROMPT_COMMAND pair) with a
  `#{pane_current_command}` fallback. Blocking builtins (`read -t 2`)
  correctly block `run` for ~2s, proving the title path works.
- Pane targets use the recorded pane id (`%N`), stable across respawns, with
  an `=session:0.0` exact-match fallback.
- `clear narration` truncates the log and `respawn-pane -k`s the tail
  process, which resets the visible grid while keeping the pane (and any
  attached window) alive.

## herbstluftwm notes (this machine's build)

- One-shot rules use `herbstclient rule once ...` — this build has **no**
  `rule add` and rejects unknown properties (`max=off` fails); rule state is
  inspectable with `herbstclient list_rules`.
- Client geometry is exposed as `floating_geometry` / `content_geometry` /
  `decoration_geometry` strings (`WxH+X+Y`); there are no separate
  `x`/`y`/`width`/`height` attributes on a client object.
- `herbstclient attr <path> | herbstutil` renders the object tree as JSON
  (`{value, children, attributes}`) — `screencastctl attrjson <path>` wraps
  this for the agent.
- Window-targeting helper scripts (`hc_center`, ...) operate on
  `clients.focus`; delegate `herbstclient jumpto <winid>` first when a
  scripted operation must target the screencast window.
