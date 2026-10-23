# Scenario 1 — tags and floating terminals

<!--
Conventions (full contract in README.md):
- Prose paragraphs are narrated live in the narration window, one at a time;
  the performer pauses after each paragraph-scene and waits for an advance
  (a TUI message).
- ```hlwm blocks are herbstclient operations — never narrated; each one is
  auto-logged live to the narration window feed.
- ```stage blocks move the narration and the agent's TUI window to the
  named tag (the narration window is display-only and is never focused).
- ```ctl blocks are agent-side screencastctl invocations — never displayed.
- ```bash blocks are delegated into the controlled terminal named in the
  @<session> annotation, or the most recently spawned one when omitted.
- A line that is a lone `sleep Ns` or `sleep Nms` code span idles first.
- Advance flow: on each advance the orchestrator (opencode) window needs
  focus. A spawned terminal takes focus (focus=on rules); the user types
  `echo advance` in it — the pane's output watcher forwards "advance" to
  the orchestrator session and returns focus to the opencode window, which
  performs the next scene.
- Spawned windows are placed explicitly on the recording tag (tag= in the
  one-shot rule, `use recording` around the spawn) so they appear there
  regardless of which tag is currently visible.
-->

## Pre-recording setup

```ctl
screencastctl spawn narration
screencastctl clear narration
```

Hello, and welcome back. In this segment we create a fresh workspace called
"recording" and watch how new windows behave under herbstluftwm's tiling.

`sleep 2s`

## Creating the tag

The tag is created and we move onto it in one step — staging must happen
while the agent window still holds focus.

```stage
recording
```

The tag "recording" now exists and is active — notice the empty root frame
in the status bar.

`sleep 1s`

## Backstage on the recording tag

Everything in this recording lives on the recording tag — including this
very agent window and the narration window beside it, which moved over
with us the moment the tag was created. From that point on, the narration
window shows the narration plus a live log of every hlwm operation.

## A floating controlled terminal

Next, a controlled terminal. The one-shot rule below floats whatever window
is created next, so the terminal appears as a floating client.

```hlwm
rule once tag=recording floating=on focus=on
spawn alacritty --class ScreencastCmd --title screencast-term1 -e /home/kine/development/system/screencast_scripts/bin/screencast-shell screencast-term1
use recording
```

There it is — a floating terminal, bound to the session
`screencast-term1`, hovering above the empty tiling root.

`sleep 2s`

## A tiled controlled terminal

Now a second controlled terminal — with no rule in place this one joins
the tiling layout instead of floating.

```hlwm
use recording
spawn alacritty --class ScreencastCmd --title screencast-term2 -e /home/kine/development/system/screencast_scripts/bin/screencast-shell screencast-term2
```

And inside it, we put the frame back into tiling mode:

```bash @screencast-term2
hc_tile
```

`sleep 1s`

## A third floating terminal

A third controlled terminal, floated again by the same one-shot rule:

```hlwm
use recording
rule once tag=recording floating=on focus=on
spawn alacritty --class ScreencastCmd --title screencast-term3 -e /home/kine/development/system/screencast_scripts/bin/screencast-shell screencast-term3
use recording
```

And finally, a greeting from the agent, rendered by figlet inside that
floating terminal:

```bash @screencast-term3
figlet "hello from opencode"
```

`sleep 3s`

That was scenario one: tags, tiling, and floating terminals — all driven
live by the agent. Thanks for watching.
