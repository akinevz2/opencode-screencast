# screencast_scripts

Infrastructure for recording herbstluftwm screencasts narrated live by an
OpenCode agent. Plain markdown scripts drive the recording; the agent reads
prose aloud into a floating narration window and silently performs the
operations described in code blocks.

## Installation

This repo is both the tooling and an OpenCode V2 plugin (`index.ts`), which
expects `bin/screencastctl` to sit next to it.

Option A — npm package:

```sh
opencode plugin add github:akinevz2/opencode-screencast
```

Option B — submodule of the OpenCode config directory (stow-friendly):

```sh
git -C ~/dots/llms/.config/opencode submodule add \
  git@github.com:akinevz2/opencode-screencast.git opencode-screencast
```

and in `opencode.jsonc` (relative paths resolve from the config file):

```jsonc
{ "plugins": ["./opencode-screencast"] }
```

Both approaches register the `screencast` tool namespace
(`spawn_window`, `narrate`, `read_window`, `clear_window`, `delegate`,
`type_keys`, `herbst`, `attr`, `wait`, `run_task`, `task_status`,
`task_wait`) and the `/screencast <script.md>` command that encodes the
script-format contract below.

## Components

| File | Purpose |
|---|---|
| `bin/screencast-shell` | Bash wrapper enabling remote agent delegation. Run it via alacritty; it binds the terminal to a persistent tmux session running an interactive bash. |
| `bin/screencast-narration` | Display wrapper for the agent narration window (runs the presenter). |
| `bin/screencast-presenter` | Narration window program: flicker-free display of the narration log (plus the live hlwm operation feed). Strictly display-only — reads no input, fires no commands, never needs focus. |
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
`screencastctl clear narration`. Two feeds land in the log: narration
paragraphs, and every hlwm operation the agent performs (`screencastctl
hlwm` live-feeds timestamped lines as they happen; the durable copy is
`${XDG_RUNTIME_DIR:-/tmp/opencode}/screencast/hlwm.log`).

Text is hard-wrapped to the live pane width at write time and the pane's
autowrap is disabled (DECRST 7, emitted by the presenter — tmux 3.6 has no
`wrap` option anymore), so the window only ever shows complete lines —
nothing is soft-wrapped or clipped. The window is strictly display-only: it
takes no input, fires no commands, and never needs focus (which is also
what keeps its theme stable — see `bin/screencast-border`).

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
screencastctl hlwm    <args...>                       # herbstclient op; live-fed to
                                                      # the narration window feed
screencastctl attrjson <object-path> [jq-filter]      # attr tree as JSON,
                                                      # optionally jq-filtered
                                                      # (reads are not fed)
screencastctl status
```

Roles: `narration` (aliases `narr`, `read`) and `command` (aliases `cmd`,
`shell`, `write`). A raw tmux session name is also accepted. The narration
window is display-only and never takes focus; it is themed per-window by
`bin/screencast-border`: a `#eeeeee` border with 25px padding and no title,
synthesized on hlwm 0.9.5 through the `urgent` theme
(while unfocused) and the `active` theme (while focused), since this build
has no per-client theming and no `border_color` rule property.

Environment overrides: `SCREENCAST_CMD_SESSION`, `SCREENCAST_NARR_SESSION`,
`SCREENCAST_RUN_TIMEOUT` (default 15s), `SCREENCAST_CMD_GEOM`,
`SCREENCAST_NARR_GEOM` (herbstluftwm floating geometry, e.g.
`1100x620+1380+760`), `SCREENCAST_NARR_WIDTH` (narration wrap width used
when no pane exists yet to query; default 160).

## Screencast script format

Scripts are plain markdown, parsed by the agent (see the `/screencast`
command once the plugin is installed):

1. **Prose paragraphs** are narration. The agent displays each paragraph in
   the narration window via `screencastctl say`, one at a time. The
   performer works **one scene per turn** — a scene is one paragraph plus
   the code blocks and sleep directives between it and the next paragraph —
   and then pauses for an advance. Advance happens via any TUI message;
   the narration window itself is display-only and takes no input.
2. **Fenced code blocks tagged `bash`** (or `sh`) are commands the agent
   delegates into the visible delegation shell via `screencastctl run`.
3. **Fenced code blocks with any other tag** (`hlwm`, `pseudocode`, ...) are
   herbstluftwm operations expressed as `herbstclient` arguments. The agent
   executes them with `screencastctl hlwm`, which live-feeds each operation
   as a timestamped line into the narration window — the audience sees
   exactly what opencode does to the window manager. The agent must never
   narrate or re-display them manually.
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
