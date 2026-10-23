# Scenario 1 — tags and floating terminals

<!--
Conventions (full contract in README.md):
- Prose paragraphs are narrated live in the narration window, one at a time.
- ```hlwm blocks are silent herbstclient operations — never displayed.
- ```ctl blocks are agent-side screencastctl invocations — never displayed.
- ```bash blocks are delegated into the controlled terminal named in the
  @<session> annotation, or the most recently spawned one when omitted.
- A line that is a lone `sleep Ns` or `sleep Nms` code span idles first.
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

```hlwm
add recording
use recording
```

The tag "recording" now exists and is active — notice the empty root frame
in the status bar.

`sleep 1s`

## A floating controlled terminal

Next, a controlled terminal. The one-shot rule below floats whatever window
is created next, so the terminal appears as a floating client.

```hlwm
rule once floating=on
spawn alacritty --class ScreencastCmd --title screencast-term1 -e /home/kine/development/system/screencast_scripts/bin/screencast-shell screencast-term1
```

There it is — a floating terminal, bound to the session
`screencast-term1`, hovering above the empty tiling root.

`sleep 2s`

## A tiled controlled terminal

Now a second controlled terminal — with no rule in place this one joins
the tiling layout instead of floating.

```hlwm
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
rule once floating=on
spawn alacritty --class ScreencastCmd --title screencast-term3 -e /home/kine/development/system/screencast_scripts/bin/screencast-shell screencast-term3
```

And finally, a greeting from the agent, rendered by figlet inside that
floating terminal:

```bash @screencast-term3
figlet "hello from opencode"
```

`sleep 3s`

That was scenario one: tags, tiling, and floating terminals — all driven
live by the agent. Thanks for watching.
