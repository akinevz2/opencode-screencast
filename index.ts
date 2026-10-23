/**
 * opencode-screencast — OpenCode plugin for live herbstluftwm screencasts.
 *
 * Feature 1 (screen interaction): tools that let the agent spawn floating
 * narration/delegation windows, narrate into them, delegate visible shell
 * commands, and drive herbstluftwm silently — all via the `screencastctl`
 * CLI that ships beside this file in bin/.
 *
 * Feature 2 (task pipeline): spawn a terminal window running a single
 * command that may request user input (e.g. sudo), with title-protocol
 * based completion detection (running -> done:<rc>) so the agent can wait
 * for the task instead of guessing.
 *
 * Layout contract: this plugin expects bin/screencastctl next to index.ts.
 * When installed as a submodule of the OpenCode config directory
 * (~/.config/opencode/opencode-screencast), bin/ ships with the checkout.
 */
import { Plugin } from "@opencode/plugin"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { readdirSync, readFileSync, readlinkSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const execFileAsync = promisify(execFile)

const here =
  typeof (import.meta as { dir?: string }).dir === "string"
    ? (import.meta as { dir: string }).dir
    : path.dirname(fileURLToPath(import.meta.url))

const CTL = path.join(here, "bin", "screencastctl")

/** Run screencastctl and return stdout. stderr flows through on failure. */
async function ctl(args: string[], timeoutMs = 120_000): Promise<string> {
  const { stdout } = await execFileAsync(CTL, args, {
    timeout: timeoutMs,
    maxBuffer: 8 * 1024 * 1024,
    encoding: "utf8",
  })
  return stdout
}

/** Parse STATE/EXIT/OUTPUT(base64) task status lines. */
function parseTaskStatus(raw: string): {
  state: string
  exit: string | null
  output: string
} {
  let state = "unknown"
  let exit: string | null = null
  let output = ""
  for (const line of raw.split("\n")) {
    if (line.startsWith("STATE ")) state = line.slice(6).trim()
    else if (line.startsWith("EXIT ")) {
      const v = line.slice(5).trim()
      exit = v === "-" ? null : v
    } else if (line.startsWith("OUTPUT ")) {
      const v = line.slice(7).trim()
      if (v !== "-") {
        try {
          output = Buffer.from(v, "base64").toString("utf8").replace(/\n+$/, "")
        } catch {
          output = ""
        }
      }
    }
  }
  return { state, exit, output }
}

const schema = {
  type: "object",
  properties: {},
  additionalProperties: false,
} as const

interface ToolDef {
  name: string
  description: string
  input: Record<string, unknown>
  execute: (input: any, context?: { sessionID?: string }) => Promise<{ content: string }>
}

export default Plugin.define({
  id: "screencast",
  async setup(ctx) {
    const tools: ToolDef[] = [
      // ---------------------------------------------------------------------
      // Feature 1 — screen interaction
      // ---------------------------------------------------------------------
      {
        name: "spawn_window",
        description:
          "Spawn a floating herbstluftwm window: role 'narration' (audience-facing agent output) or 'command' (a controlled terminal the agent can delegate into). Persistent across window close. For narration windows, advance_command (if given) is executed whenever the user presses a key in the window — used to advance a screencast script.",
        input: {
          type: "object",
          properties: {
            role: { type: "string", enum: ["narration", "command"] },
            session: { type: "string", description: "Optional tmux session name; defaults per role." },
            advance_command: {
              type: "string",
              description: "narration only: shell command fired on keypress in the window, e.g. 'opencode run -s <sessionID> advance'",
            },
          },
          required: ["role"],
          additionalProperties: false,
        },
        execute: async ({ role, session, advance_command }) => {
          const args = ["spawn", role]
          if (session) args.push(session)
          if (advance_command) args.push("--advance", advance_command)
          return { content: (await ctl(args)).trim() }
        },
      },
      {
        name: "narrate",
        description:
          "Display one narration paragraph in the floating narration window for the audience. Call once per paragraph.",
        input: {
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
          additionalProperties: false,
        },
        execute: async ({ text }) => {
          await ctl(["say", text])
          return { content: "narrated" }
        },
      },
      {
        name: "read_window",
        description:
          "Read what is currently visible in a screencast window (narration or command), including recent scrollback. Use to verify what the audience sees or to collect command output.",
        input: {
          type: "object",
          properties: {
            role: { type: "string", enum: ["narration", "command"] },
            lines: { type: "number", description: "Only the last N lines; omit for full pane." },
          },
          required: ["role"],
          additionalProperties: false,
        },
        execute: async ({ role, lines }) => {
          const args = ["read", role]
          if (typeof lines === "number") args.push("--lines", String(lines))
          return { content: (await ctl(args)).trimEnd() }
        },
      },
      {
        name: "clear_window",
        description: "Wipe screen and history of a screencast window (narration or command).",
        input: {
          type: "object",
          properties: { role: { type: "string", enum: ["narration", "command"] } },
          required: ["role"],
          additionalProperties: false,
        },
        execute: async ({ role }) => {
          await ctl(["clear", role])
          return { content: "cleared" }
        },
      },
      {
        name: "delegate",
        description:
          "Type a command into the visible controlled terminal and wait for the prompt to return. Returns only the newly produced output. The audience sees the typing live.",
        input: {
          type: "object",
          properties: {
            command: { type: "string" },
            session: { type: "string", description: "Target tmux session; defaults to the main command window." },
          },
          required: ["command"],
          additionalProperties: false,
        },
        execute: async ({ command, session }) => {
          const args = ["run"]
          if (session) args.push(session)
          args.push(command)
          return { content: (await ctl(args)).trimEnd() }
        },
      },
      {
        name: "type_keys",
        description: "Send raw key events to the controlled terminal (e.g. C-c, Enter, Escape).",
        input: {
          type: "object",
          properties: {
            keys: { type: "array", items: { type: "string" } },
            session: { type: "string" },
          },
          required: ["keys"],
          additionalProperties: false,
        },
        execute: async ({ keys, session }) => {
          const args = ["key"]
          if (session) args.push(session)
          args.push(...keys)
          await ctl(args)
          return { content: "sent" }
        },
      },
      {
        name: "herbst",
        description:
          "Run a herbstclient command silently (window manager operations). These are never shown on screen. Example: args ['add', 'recording'].",
        input: {
          type: "object",
          properties: { args: { type: "array", items: { type: "string" } } },
          required: ["args"],
          additionalProperties: false,
        },
        execute: async ({ args }) => {
          return { content: (await ctl(["hlwm", ...args])).trim() }
        },
      },
      {
        name: "attr",
        description:
          "Read a herbstluftwm object path (GET: attr without a value) as JSON via herbstclient attr + herbstutil. Returns {value, children, attributes}. Optionally pass a jq filter to transform/shrink the result before it reaches the model. Note: herbstutil renders hlwm attribute values as JSON strings, so `.attributes.X | fromjson` yields the native JSON value. Prefer this tool over calling `herbstclient attr` through bash: the structured output is cheaper and needs no post-processing. Setting attribute values is a write — use screencast_herbst with args ['attr', path, value].",
        input: {
          type: "object",
          properties: {
            object_path: {
              type: "string",
              description: "hlwm object path, e.g. clients.focus, tags.focus, monitors.0",
            },
            jq: {
              type: "string",
              description: "Optional jq filter applied to the JSON, e.g. '.attributes', '.attributes.floating_geometry', or '.attributes | map_values(try fromjson catch .)' to unwrap hlwm's string-quoted values into native JSON",
            },
          },
          required: ["object_path"],
          additionalProperties: false,
        },
        execute: async ({ object_path, jq }) => {
          const args = ["attrjson", object_path]
          if (typeof jq === "string" && jq.trim() !== "") args.push(jq)
          const raw = await ctl(args)
          try {
            return { content: JSON.stringify(JSON.parse(raw)) }
          } catch {
            return { content: raw }
          }
        },
      },
      {
        name: "wait",
        description: "Idle for a number of milliseconds (screencast timing directive).",
        input: {
          type: "object",
          properties: { ms: { type: "number" } },
          required: ["ms"],
          additionalProperties: false,
        },
        execute: async ({ ms }) => {
          const n = Math.max(0, Math.min(Number(ms) || 0, 600_000))
          await new Promise((r) => setTimeout(r, n))
          return { content: `waited ${n}ms` }
        },
      },
      {
        name: "stage",
        description:
          "Move the screencast 'backstage' windows — the floating narration window and the OpenCode TUI window (the orchestrator running the interactive session that requested the screencast) — to a workspace (tag), then switch the view back to where it was. Keeps the recording workspace free of backstage windows.",
        input: {
          type: "object",
          properties: {
            tag: { type: "string", description: "Destination herbstluftwm tag name (created if missing)." },
            dry_run: { type: "boolean", description: "Report which windows would move without moving anything." },
          },
          required: ["tag"],
          additionalProperties: false,
        },
        execute: async ({ tag, dry_run }, context) => {
          // Pin the orchestrator to the CALLING session's project directory:
          // the TUI window running the interactive session that invoked this
          // tool is the one whose opencode process cwd is that directory.
          let sessionDir = ""
          if (context?.sessionID) {
            try {
              const session = await ctx.session.get({ sessionID: context.sessionID })
              const loc = (session as { location?: { directory?: string } }).location
              sessionDir = loc?.directory ?? ""
            } catch {
              /* fall back to no pinning */
            }
          }
          // Snapshot the process table once: pid -> {ppid, argv}.
          const procs = new Map<number, { ppid: number; argv: string[] }>()
          for (const d of readdirSync("/proc")) {
            if (!/^\d+$/.test(d)) continue
            try {
              const stat = readFileSync(`/proc/${d}/stat`, "utf8")
              const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ")
              const argv = readFileSync(`/proc/${d}/cmdline`, "utf8").split("\0").filter(Boolean)
              procs.set(Number(d), { ppid: Number(rest[1]), argv })
            } catch {
              /* process vanished */
            }
          }
          // Find this subtree's opencode process belonging to the calling
          // session's project: any process whose argv[0] is opencode and
          // whose working directory is inside the session's directory.
          // Falls back to a bare TUI match (argv exactly ["opencode"])
          // when the session directory is unavailable.
          const findTuiPid = (root: number): number | null => {
            const stack = [root]
            const seen = new Set<number>()
            while (stack.length) {
              const pid = stack.pop()!
              if (seen.has(pid)) continue
              seen.add(pid)
              const p = procs.get(pid)
              if (!p) continue
              const base = (p.argv[0] ?? "").split("/").pop()
              if (base === "opencode") {
                if (!sessionDir) {
                  if (p.argv.length === 1) return pid
                } else {
                  try {
                    const cwd = readlinkSync(`/proc/${pid}/cwd`)
                    if (cwd === sessionDir || cwd.startsWith(sessionDir + "/")) return pid
                  } catch {
                    /* cwd unreadable */
                  }
                }
              }
              for (const [cpid, c] of procs) if (c.ppid === pid) stack.push(cpid)
            }
            return null
          }

          const clients = JSON.parse(await ctl(["attrjson", "clients"]))
          const winids: string[] = Array.isArray(clients.children) ? clients.children : []

          const narration: string[] = []
          const orchestrators: string[] = []
          const seenWinids = new Set<string>()
          for (const w of winids) {
            const a = JSON.parse(
              await ctl([
                "attrjson",
                `clients.${w}`,
                ".attributes | {class, instance, pid, tag, winid} | map_values(try fromjson catch .)",
              ]),
            )
            // hlwm exposes a `focus` alias among the children — dedupe on
            // the real winid so a focused window is never counted twice.
            const winid = String(a.winid ?? w)
            if (seenWinids.has(winid)) continue
            seenWinids.add(winid)
            const klass = String(a.class ?? "")
            const pid = Number(a.pid ?? 0)
            const winTag = String(a.tag ?? "")
            if (klass === "ScreencastNarr" || klass === "ScreencastCmd") {
              if (klass === "ScreencastNarr" && winTag !== tag) narration.push(w)
              continue
            }
            if (winTag !== tag && pid > 0 && findTuiPid(pid) !== null) orchestrators.push(w)
          }

          const prev = JSON.parse(await ctl(["attrjson", "monitors.focus", ".attributes.tag | fromjson"]))
          const moved: string[] = []
          if (!dry_run) {
            for (const w of [...narration, ...orchestrators]) {
              await ctl(["hlwm", "jumpto", w])
              await ctl(["hlwm", "move", tag])
              moved.push(w)
            }
            if (moved.length > 0 && prev && prev !== tag) {
              await ctl(["hlwm", "use", String(prev)])
            }
          }
          return {
            content: JSON.stringify({
              moved,
              dry_run: dry_run === true,
              narration: narration.length,
              orchestrators: orchestrators.length,
              returned_to: prev ?? null,
            }),
          }
        },
      },

      // ---------------------------------------------------------------------
      // Feature 2 — task pipeline (visible command + completion detection)
      // ---------------------------------------------------------------------
      {
        name: "run_task",
        description:
          "Spawn a floating terminal running a single command that may request user input (e.g. sudo). The window title reports 'running' while it executes and 'done:<rc>' when it finishes, then drops to a delegation shell. Returns the session id used for task_status/task_wait.",
        input: {
          type: "object",
          properties: {
            command: { type: "string", description: "Single-line shell command." },
            session: { type: "string", description: "Task session name; defaults to screencast-task." },
          },
          required: ["command"],
          additionalProperties: false,
        },
        execute: async ({ command, session }) => {
          const args = ["spawn-task"]
          if (session) args.push(session)
          args.push(command)
          const sid = (await ctl(args)).trim()
          return { content: `task session: ${sid}` }
        },
      },
      {
        name: "task_status",
        description:
          "Poll a task session: state (absent/running/done), exit code when done, and the last lines of visible output.",
        input: {
          type: "object",
          properties: { session: { type: "string" } },
          required: ["session"],
          additionalProperties: false,
        },
        execute: async ({ session }) => {
          const status = parseTaskStatus(await ctl(["task-status", session]))
          return { content: JSON.stringify(status) }
        },
      },
      {
        name: "task_wait",
        description:
          "Wait until a task session finishes (or the timeout elapses), then return state, exit code and output tail.",
        input: {
          type: "object",
          properties: {
            session: { type: "string" },
            timeout_s: { type: "number", description: "Seconds to wait; default 30." },
          },
          required: ["session"],
          additionalProperties: false,
        },
        execute: async ({ session, timeout_s }) => {
          const args = ["task-wait"]
          if (typeof timeout_s === "number") args.push(String(timeout_s))
          args.push(session)
          const status = parseTaskStatus(await ctl(args, (Math.max(30, Number(timeout_s) || 30) + 15) * 1000))
          return { content: JSON.stringify(status) }
        },
      },
    ]

    await ctx.tool.transform((editor) => {
      editor.namespace({
        name: "screencast",
        description: "Drive herbstluftwm screencast windows (narration, delegation, hlwm ops, tasks).",
      })
      for (const tool of tools) {
        editor.add({
          name: tool.name,
          description: tool.description,
          input: tool.input as never,
          options: { namespace: "screencast", codemode: true },
          execute: async (input: unknown) => tool.execute(input),
        })
      }
    })

    await ctx.command.transform((editor) => {
      editor.add({
        name: "screencast",
        description: "Perform a screencast script (markdown) live on screen",
        execute: async ({ sessionID, prompt, delivery }) => {
          const script = prompt.text.trim()
          const contract = [
            "You are performing a LIVE screencast of herbstluftwm. The audience watches the screen; your narration appears in the floating narration window. The script drives everything. You perform it ONE SCENE PER TURN.",
            script ? `Script file: ${script} — read it with the read tool.` : "No script path was given; ask the user for one.",
            "",
            "SCENE definition: a scene is ONE narration paragraph plus everything between it and the next paragraph (code blocks and sleep directives). Scenes are performed strictly in file order.",
            "",
            `Per turn, perform exactly ONE scene:`,
            `1. Before the first scene: spawn the narration window (screencast_spawn_window, role=narration) with advance_command "opencode run -s ${sessionID} advance", then screencast_clear_window role=narration.`,
            "2. Narrate the scene's paragraph verbatim (screencast_narrate). Never display anything else in the narration window.",
            "3. Execute the scene's code blocks in order: hlwm → screencast_herbst per line; ctl → run locally via bash; bash @session → screencast_delegate with session = annotation without @ (the audience sees the typing live).",
            "4. Execute the scene's `sleep Ns`/`sleep Nms` directives with screencast_wait.",
            "5. END THE TURN immediately after one scene. Never perform two scenes in one turn. Never add your own commentary.",
            "",
            `ADVANCE PROTOCOL: after each scene the recording pauses. The user advances by sending any message in the TUI (default) or by pressing a key in the narration window (which submits an automatic "advance" prompt). Any new user message means: perform the NEXT scene, reading it from the file rather than from memory.`,
            "",
            "Begin now.",
          ].join("\n")
          await ctx.session.prompt({ sessionID, text: contract, delivery })
        },
      })
    })
  },
})
