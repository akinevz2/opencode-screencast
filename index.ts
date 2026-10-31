/**
 * opencode-screencast — OpenCode plugin for live herbstluftwm screencasts.
 *
 * Feature 1 (screen interaction): tools that let the agent spawn floating
 * narration/delegation windows, narrate into them, delegate visible shell
 * commands, and drive herbstluftwm silently — all via the `screencastctl`
 * CLI that ships beside this file in bin/.
 *
 * Feature 2 (task pipeline): spawn a terminal window running a single
 * command that may request user input (e.g. sudo). The task session is
 * durably registered at spawn and completion is signaled by an exit
 * sentinel rather than the transient window title (running -> done:<rc>,
 * or "lost" when the window is closed before the command finishes) so
 * the agent can wait for the task instead of guessing.
 *
 * Layout contract: this plugin expects bin/screencastctl next to index.ts.
 * When installed as a submodule of the OpenCode config directory
 * (~/.config/opencode/opencode-screencast), bin/ ships with the checkout.
 */
import { Plugin } from "@opencode/plugin"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import path from "node:path"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import type { Scenario, ScenarioSpec, Scene, Camera, Client, User } from "./scenario"

const execFileAsync = promisify(execFile)

const here =
  typeof (import.meta as { dir?: string }).dir === "string"
    ? (import.meta as { dir: string }).dir
    : path.dirname(fileURLToPath(import.meta.url))

const CTL = path.join(here, "bin", "screencastctl")

/** Durable runtime state (mirrors screencastctl's RUNTIME_DIR). */
const RUNTIME_DIR = path.join(process.env.XDG_RUNTIME_DIR || "/tmp/opencode", "screencast")
const ORCH_FILE = path.join(RUNTIME_DIR, "orchestrator.winid")

// Scenario layer (OOP fluent API) — exported for authoring; no tools yet.
export type { Scenario, ScenarioSpec, Scene, Camera, Client, User, ScenarioIssue }

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
  /** `never` parameter: each concrete tool narrows the input type; the
   *  registration site casts through `as never`. */
  execute: (input: never) => Promise<{ content: string }>
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
          "Spawn a floating herbstluftwm window: role 'narration' (audience-facing agent output) or 'command' (a controlled terminal the agent can delegate into). Persistent across window close. Narration windows are strictly display-only: they take no input and never need focus, and they live-display the hlwm operation feed (every screencast_herbst call) alongside the narration.",
        input: {
          type: "object",
          properties: {
            role: { type: "string", enum: ["narration", "command"] },
            session: { type: "string", description: "Optional tmux session name; defaults per role." },
          },
          required: ["role"],
          additionalProperties: false,
        },
        execute: async ({ role, session }: { role: "narration" | "command"; session?: string }) => {
          const args = ["spawn", role]
          if (session) args.push(session)
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
        execute: async ({ text }: { text: string }) => {
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
        execute: async ({ role, lines }: { role: "narration" | "command"; lines?: number }) => {
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
        execute: async ({ role }: { role: "narration" | "command" }) => {
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
        execute: async ({ command, session }: { command: string; session?: string }) => {
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
        execute: async ({ keys, session }: { keys: string[]; session?: string }) => {
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
          "Run a herbstclient command (window manager operations). Every operation is live-fed to the narration window as a timestamped log line, so the audience sees what opencode does to the window manager while broadcasting. Example: args ['add', 'recording'].",
        input: {
          type: "object",
          properties: { args: { type: "array", items: { type: "string" } } },
          required: ["args"],
          additionalProperties: false,
        },
        execute: async ({ args }: { args: string[] }) => {
          return { content: (await ctl(["hlwm", ...args])).trim() }
        },
      },
      {
        name: "attr",
        description:
          "Read a herbstluftwm object path (GET: attr without a value) as JSON via herbstclient attr + herbstutil. Returns {value, children, attributes}. Optionally pass a jq filter to transform/shrink the result before it reaches the model. Note: herbstutil renders hlwm attribute values as JSON strings, so `.attributes.X | fromjson` yields the native JSON value. Prefer this tool over calling `herbstclient attr` through bash: the structured output is cheaper and needs no post-processing. Read-only: attr reads are not shown in the narration operation feed. Setting attribute values is a write — use screencast_herbst with args ['attr', path, value].",
        input: {
          type: "object",
          properties: {
            object_path: {
              type: "string",
              description: "hlwm object path, e.g. clients.focus, tags.focus, monitors.0",
            },
            jq: {
              type: "string",
              description: "Optional jq filter applied to the JSON, e.g. '.attributes', '.attributes.floating_geometry', or '.attributes' to unwrap hlwm's string-quoted values into native JSON",
            },
          },
          required: ["object_path"],
          additionalProperties: false,
        },
        execute: async ({ object_path, jq }: { object_path: string; jq?: string }) => {
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
        execute: async ({ ms }: { ms: number }) => {
          const n = Math.max(0, Math.min(Number(ms) || 0, 600_000))
          await new Promise((r) => setTimeout(r, n))
          return { content: `waited ${n}ms` }
        },
      },
      {
        name: "stage",
        description:
          "Move the screencast 'backstage' windows — the floating narration window and the OpenCode TUI window (the orchestrator running the interactive session that requested the screencast) — to a workspace (tag), creating it if needed, and switch the view to that tag. Keeps the whole performance on one workspace. The narration window is never focused: it is display-only.",
        input: {
          type: "object",
          properties: {
            tag: { type: "string", description: "Destination herbstluftwm tag name (created if missing)." },
            dry_run: { type: "boolean", description: "Report which windows would move without moving anything." },
          },
          required: ["tag"],
          additionalProperties: false,
        },
        execute: async ({ tag, dry_run }: { tag: string; dry_run?: boolean }) => {
          // The controlling opencode window is the FOCUSED window: the user
          // drives the session from the TUI, so it holds focus at staging
          // time. Resolved as clients.focus — no process walking.

          const clients = JSON.parse(await ctl(["attrjson", "clients"]))
          const winids: string[] = Array.isArray(clients.children) ? clients.children : []

          const narration: string[] = []
          const seenWinids = new Set<string>()
          for (const w of winids) {
            const a = JSON.parse(
              await ctl([
                "attrjson",
                `clients.${w}`,
                ".attributes | {class, instance, pid, tag, winid}",
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
              if (klass === "ScreencastNarr" && winTag !== tag) narration.push(winid)
              continue
            }
          }

          // The orchestrator is whatever window currently holds focus —
          // unless that is the narration window itself (it never controls
          // the session). Staging must run while a window is focused; if
          // the view is on an empty frame, move only the narration and
          // report it rather than failing mid-take.
          let orchestrators: string[] = []
          try {
            const focusWinid = String(
              JSON.parse(await ctl(["attrjson", "clients.focus", ".attributes.winid | fromjson"])),
            )
            if (focusWinid && !narration.includes(focusWinid)) orchestrators = [focusWinid]
          } catch {
            /* no focused client (empty frame) — narration-only move */
          }

          const prev = JSON.parse(await ctl(["attrjson", "monitors.focus", ".attributes.tag | fromjson"]))
          const moved: string[] = []
          if (!dry_run) {
            // Create the destination tag if it does not exist yet.
            await ctl(["hlwm", "silent", "add", String(tag)])
            // 1. The narration window moves FIRST (jumpto focuses it,
            //    which clears urgent — the flag is re-asserted right
            //    after the workspace switch, once focus has left it).
            for (const w of narration) {
              await ctl(["hlwm", "jumpto", w])
              await ctl(["hlwm", "move", String(tag)])
              moved.push(w)
            }
            // 2. The workspace is focused (view switches to the destination
            //    tag, narration visible on it) — and with focus gone from
            //    the narration, its themed urgent look is restored.
            await ctl(["hlwm", "use", String(tag)])
            for (const w of narration) {
              await ctl(["hlwm", "attr", `clients.${w}.urgent`, "true"])
            }
            // 3. Then the orchestrator is brought over — focus naturally
            //    lands on it as the last-moved window, never on the
            //    display-only narration.
            for (const w of orchestrators) {
              await ctl(["hlwm", "jumpto", w])
              await ctl(["hlwm", "move", String(tag)])
              moved.push(w)
            }
            // 4. Guarantee the view (and focus) end on the destination tag:
            //    jumpto+move of the orchestrator can leave the view on its
            //    original (now empty) tag.
            await ctl(["hlwm", "use", String(tag)])
          }
          return {
            content: JSON.stringify({
              moved,
              dry_run: dry_run === true,
              narration: narration.length,
              orchestrators: orchestrators.length,
              orchestrator_winid: orchestrators[0] ?? null,
              previous_tag: prev ?? null,
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
          "Spawn a floating terminal running a single command that may request user input (e.g. sudo). The session is durably registered the moment it is created, so task_status reports it immediately (never 'absent' for a returned session id). Completion is signaled by a durable exit sentinel, not the transient window title: state 'running' while it executes, 'done:<rc>' when it finishes, then the window drops to a delegation shell. If the window is closed before the command finishes, task_status reports state 'lost'. Returns the session id used for task_status/task_wait.",
        input: {
          type: "object",
          properties: {
            command: { type: "string", description: "Single-line shell command." },
            session: { type: "string", description: "Task session name; defaults to screencast-task." },
          },
          required: ["command"],
          additionalProperties: false,
        },
        execute: async ({ command, session }: { command: string; session?: string }) => {
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
          "Poll a task session: state (absent = never spawned, running, done = finished with the real exit code, lost = the session vanished before finishing, e.g. the task window was closed mid-run), exit code when done, and the last lines of visible output.",
        input: {
          type: "object",
          properties: { session: { type: "string" } },
          required: ["session"],
          additionalProperties: false,
        },
        execute: async ({ session }: { session: string }) => {
          const status = parseTaskStatus(await ctl(["task-status", session]))
          return { content: JSON.stringify(status) }
        },
      },
      {
        name: "task_wait",
        description:
          "Wait until a task session finishes (done), disappears mid-run (lost), or the timeout elapses, then return state, exit code and output tail.",
        input: {
          type: "object",
          properties: {
            session: { type: "string" },
            timeout_s: { type: "number", description: "Seconds to wait; default 30." },
          },
          required: ["session"],
          additionalProperties: false,
        },
        execute: async ({ session, timeout_s }: { session: string; timeout_s?: number }) => {
          const args = ["task-wait"]
          if (typeof timeout_s === "number") args.push(String(timeout_s))
          args.push(session)
          const status = parseTaskStatus(await ctl(args, (Math.max(30, Number(timeout_s) || 30) + 15) * 1000))
          return { content: JSON.stringify(status) }
        },
      },
    ]

      // ---------------------------------------------------------------------
      // ---------------------------------------------------------------------
      // Feature 1b — floating-layer geometry (disjoin_rects presentation fit)
      // ---------------------------------------------------------------------
      // Concept: floating windows obscure the tiling layer and each other —
      // unwanted during a presentation. These tools compute non-obscuring
      // placements from `herbstclient disjoin_rects` partitions of the
      // DECORATED geometries (deco frames bleed outward: ~7px borders plus
      // ~29px titlebar, so client rects must be inset before comparing).

      /** Geometry rect in screen coordinates. */
      interface Rect { x: number; y: number; w: number; h: number }
      /** hlwm rect literal, "WxH+X+Y" (offsets may be negative). */
      type RectStr = string

      interface DecoMargins { left: number; top: number; right: number; bottom: number }

      /** The attributes the tools need from a client, as herbstutil emits
       *  them: strings/booleans native, geometries as {x,y,width,height}. */
      interface ClientAttrs {
        winid?: string
        class?: string
        title?: string
        tag?: string
        floating?: boolean | string
        minimized?: boolean | string
        floating_geometry?: Rect | RectStr | null
        decoration_geometry?: Rect | RectStr | null
        content_geometry?: Rect | RectStr | null
      }

      interface ClientRects {
        winid: string
        tag: string | null
        floating: boolean
        floating_geometry: Rect | null
        decoration_geometry: Rect | null
        deco_rect: RectStr | null
        deco_margins: DecoMargins | null
      }

      interface FloatEntry { winid: string; rect: Rect; attrs: ClientAttrs }

      /** One output rect of disjoin_rects, annotated with the floats whose
       *  decorated frames overlap it (empty = a safe presentation slot). */
      interface PartitionRect { rect: RectStr; area: number; obscured_by: string[] }
      interface Partition {
        target: string
        target_deco: RectStr
        floats: { winid: string; rect: RectStr }[]
        rects: PartitionRect[]
      }

      interface Placement {
        winid: string
        floating_geometry: RectStr
        deco: RectStr
      }

      interface PlaceOpts {
        shrink?: boolean
        /** Other floats' DECORATED rects to resolve overlaps against. */
        floats?: { winid: string; rect: Rect }[]
      }

      const MIN_W = 200
      const MIN_H = 150

      const isRectObj = (s: unknown): s is { x: number; y: number; width: number; height: number } =>
        typeof s === "object" && s !== null

      /** Accepts a hlwm "WxH+X+Y" literal or herbstutil's native
       *  {x,y,width,height} object; null when neither. */
      const parseRect = (s: unknown): Rect | null => {
        if (isRectObj(s)) {
          const x = Number(s.x), y = Number(s.y), w = Number(s.width), h = Number(s.height)
          return [x, y, w, h].every(Number.isFinite) ? { x, y, w, h } : null
        }
        if (typeof s !== "string") return null
        const m = s.trim().match(/^(\d+)x(\d+)([+-]\d+)([+-]\d+)$/)
        return m ? { w: +m[1], h: +m[2], x: +m[3], y: +m[4] } : null
      }
      const rectStr = (r: Rect): RectStr => `${r.w}x${r.h}+${r.x}+${r.y}`
      const area = (r: Rect): number => r.w * r.h
      /** Strict positive-area intersection: shared edges do NOT count. */
      const overlaps = (a: Rect, b: Rect): boolean =>
        a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
      const intersect = (a: Rect, b: Rect): Rect | null => {
        const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y)
        const w = Math.min(a.x + a.w, b.x + b.w) - x
        const h = Math.min(a.y + a.h, b.y + b.h) - y
        return w > 0 && h > 0 ? { x, y, w, h } : null
      }
      const isFloating = (a: ClientAttrs): boolean => a.floating === true || a.floating === "true"
      const decoMargins = (float: Rect, deco: Rect): DecoMargins => ({
        left: float.x - deco.x,
        top: float.y - deco.y,
        right: deco.x + deco.w - (float.x + float.w),
        bottom: deco.y + deco.h - (float.y + float.h),
      })

      /** All clients with typed attrs, keyed by winid (herbstutil child keys
       *  carry a trailing dot — stripped; the `focus` alias child dropped). */
      async function allClients(): Promise<Record<string, ClientAttrs>> {
        const raw = await ctl(["attrjson", "clients", "[.children[] | select(. != \"focus.\") | sub(\"\\\\.$\"; \"\")]"])
        const winids: string[] = JSON.parse(raw)
        const out: Record<string, ClientAttrs> = {}
        for (const w of winids) {
          const a: ClientAttrs = JSON.parse(
            await ctl([
              "attrjson", `clients.${w}`,
              ".attributes | {winid, class, title, tag, floating, minimized, floating_geometry, decoration_geometry}",
            ]),
          )
          out[String(a.winid ?? w)] = a
        }
        return out
      }

      async function monitorRect(): Promise<Rect> {
        const g = JSON.parse(await ctl(["attrjson", "monitors.focus", ".attributes.geometry"]))
        return { x: Number(g.x), y: Number(g.y), w: Number(g.width), h: Number(g.height) }
      }

      /** Resolve a tool's winid input; ""/missing means the focused client. */
      async function resolveWinid(winid: unknown): Promise<string> {
        if (typeof winid === "string" && winid !== "") return winid
        const raw = await ctl(["attrjson", "clients.focus", ".attributes.winid"])
        return String(JSON.parse(raw))
      }

      /** disjoin_rects partition of the MONITOR rect + the target's deco
       *  rect + every other floating window's deco rect. The monitor must
       *  be an input: disjoin_rects only partitions the UNION of its
       *  arguments, so without it the empty screen regions — the slots a
       *  window should move into — never appear. */
      async function disjointPartition(targetWinid: string): Promise<Partition> {
        const clients = await allClients()
        const target = clients[targetWinid]
        if (!target) throw new Error(`no such client: ${targetWinid}`)
        const tDeco = parseRect(target.decoration_geometry)
        if (!tDeco) throw new Error(`client ${targetWinid} has no decoration_geometry`)
        const floats: FloatEntry[] = []
        for (const [winid, a] of Object.entries(clients)) {
          if (winid === targetWinid || !isFloating(a)) continue
          const r = parseRect(a.decoration_geometry)
          if (r) floats.push({ winid, rect: r, attrs: a })
        }
        const { stdout } = await execFileAsync(
          "herbstclient",
          ["disjoin_rects", rectStr(await monitorRect()), rectStr(tDeco), ...floats.map((f) => rectStr(f.rect))],
          { timeout: 15_000, maxBuffer: 1024 * 1024 },
        )
        const rects: PartitionRect[] = stdout.trim().split("\n").filter(Boolean).map((line) => {
          const rect = parseRect(line)
          if (!rect) throw new Error(`disjoin_rects emitted unparseable rect: ${line}`)
          return {
            rect: rectStr(rect),
            area: area(rect),
            obscured_by: floats.filter((f) => overlaps(rect, f.rect)).map((f) => f.winid),
          }
        })
        return {
          target: targetWinid,
          target_deco: rectStr(tDeco),
          floats: floats.map((f) => ({ winid: f.winid, rect: rectStr(f.rect) })),
          rects,
        }
      }

      /** Largest partition rect with no overlap against other floats. */
      function largestFree(part: Partition): PartitionRect | null {
        const free = part.rects.filter((r) => r.obscured_by.length === 0)
        if (free.length === 0) return null
        return free.reduce((best, r) => (r.area > best.area ? r : best))
      }

      /** Pure placement computation: client rect whose DECORATED frame lands
       *  on `want`, clamped deco-aware to the monitor; with shrink, overlaps
       *  against `floats` resolved by moving/shrinking (floor 200x150).
       *  No hlwm side effects — the lock=true path reuses this. */
      async function computePlacement(winid: string, want: Rect, opts: PlaceOpts = {}): Promise<Placement> {
        const a: ClientAttrs = JSON.parse(
          await ctl(["attrjson", `clients.${winid}`, ".attributes | {floating_geometry, decoration_geometry}"]),
        )
        const cur = parseRect(a.floating_geometry)
        const deco = parseRect(a.decoration_geometry)
        if (!cur || !deco) throw new Error(`client ${winid} has no float/deco geometry`)
        const m = decoMargins(cur, deco)
        let r: Rect = {
          x: want.x + m.left,
          y: want.y + m.top,
          w: Math.max(MIN_W, want.w - m.left - m.right),
          h: Math.max(MIN_H, want.h - m.top - m.bottom),
        }
        const mon = await monitorRect()
        r.w = Math.min(r.w, mon.w - m.left - m.right)
        r.h = Math.min(r.h, mon.h - m.top - m.bottom)
        r.x = Math.max(mon.x + m.left, Math.min(r.x, mon.x + mon.w - m.right - r.w))
        r.y = Math.max(mon.y + m.top, Math.min(r.y, mon.y + mon.h - m.bottom - r.h))
        if (opts.shrink && opts.floats) {
          for (const f of opts.floats) {
            const decoFrame: Rect = {
              x: r.x - m.left, y: r.y - m.top,
              w: r.w + m.left + m.right, h: r.h + m.top + m.bottom,
            }
            const iv = intersect(decoFrame, f.rect)
            if (!iv) continue
            const dx = iv.x + iv.w <= decoFrame.x + decoFrame.w / 2 ? iv.w : 0
            const dy = iv.y + iv.h <= decoFrame.y + decoFrame.h / 2 ? iv.h : 0
            r.w = Math.max(MIN_W, r.w - dx)
            r.h = Math.max(MIN_H, r.h - dy)
            if (dx && iv.x >= r.x) r.x = iv.x + iv.w - m.left
            if (dy && iv.y >= r.y) r.y = iv.y + iv.h - m.top
          }
        }
        const placedDeco: Rect = {
          x: r.x - m.left, y: r.y - m.top,
          w: r.w + m.left + m.right, h: r.h + m.top + m.bottom,
        }
        return { winid, floating_geometry: rectStr(r), deco: rectStr(placedDeco) }
      }

      /** Compute + apply (visible write path). */
      async function placeFloating(winid: string, want: Rect, opts: PlaceOpts = {}): Promise<Placement> {
        const placed = await computePlacement(winid, want, opts)
        await ctl(["hlwm", "silent", "attr", `clients.${winid}.floating`, "true"])
        await ctl(["hlwm", "silent", "attr", `clients.${winid}.floating_geometry`, placed.floating_geometry])
        return placed
      }

      interface RectToolInput { winid?: string }

      const rectInput = {
        type: "object",
        properties: {
          winid: { type: "string", description: "Client winid (0x…); omit for the focused window." },
        },
        additionalProperties: false,
      } as const

      /** Collect the decorated rects of every other floating window. */
      async function otherFloatRects(winid: string): Promise<{ winid: string; rect: Rect }[]> {
        const clients = await allClients()
        const others: { winid: string; rect: Rect }[] = []
        for (const [id, a] of Object.entries(clients)) {
          if (id === winid || !isFloating(a)) continue
          const r = parseRect(a.decoration_geometry)
          if (r) others.push({ winid: id, rect: r })
        }
        return others
      }

      // ---------------------------------------------------------------------
      // Feature 1c — uncovering a tiling window obscured by floats
      // ---------------------------------------------------------------------
      // hlwm facts this relies on (verified live, 0.9.5):
      //  - `split <dir> <fraction>` keeps the CLIENTS on the side OPPOSITE
      //    `<dir>`: split bottom -> clients top; split top -> clients bottom.
      //    `fraction` is always the top/left child's share.
      //  - Empty frames PERSIST after their client leaves (close/float);
      //    `herbstclient load <tag> <tree>` resets a whole layout.
      //  - A floating client unfloated while frame focus is on frame X is
      //    re-tiled INTO X: float -> `cycle_frame` -> floating=false is the
      //    "jump to the free branch" maneuver (polyframes tile's "closest
      //    empty frame" jumps BACK into the vacated covered frame instead).

      interface FrameInfo { path: string; geometry: Rect; index: string }

      /** hlwm object tree indexes tags numerically — resolve name → index.
       *  NOTE: `silent` would suppress the attr output itself, so probe
       *  with plain attr and swallow the failure exit code. */
      async function tagIndexOf(tagName: string): Promise<string | null> {
        for (let i = 0; i < 32; i++) {
          const name = await ctl(["hlwm", "attr", `tags.${i}.name`]).catch(() => "")
          if (name.trim() === tagName) return String(i)
        }
        return null
      }

      /** The leaf frame containing the focused client: hlwm exposes it as
       *  tags.<i>.tiling.focused_frame with its index path into the tree.
       *  The caller must jumpto the client first. */
      async function frameOfClient(tagName: string, winid: string): Promise<FrameInfo | null> {
        const idx = await tagIndexOf(tagName)
        if (!idx) return null
        const base = `tags.${idx}.tiling.focused_frame`
        const node: { index?: string; geo?: unknown } = JSON.parse(
          await ctl(["attrjson", base, "{index: .attributes.index, geo: .attributes.content_geometry}"]),
        )
        const geo = parseRect(node.geo)
        if (typeof node.index !== "string" || !geo) return null
        return { path: `tags.${idx}.tiling.root.${node.index}`, geometry: geo, index: node.index }
      }

      interface UncoverResult {
        action: "none" | "split" | "split+jump" | "unsupported"
        winid: string
        frame: string
        split_direction?: "bottom" | "top" | "left" | "right"
        fraction?: number
        before: RectStr
        after?: RectStr | null
        uncovered?: boolean
        note?: string
      }

      const uncoverTiling = async (input: { winid?: string; tolerance?: number }): Promise<UncoverResult> => {
        const tol = Math.max(0, input.tolerance ?? 8)
        const w = await resolveWinid(input.winid)
        const a: ClientAttrs = JSON.parse(
          await ctl(["attrjson", `clients.${w}`, ".attributes | {winid, tag, floating, content_geometry}"]),
        )
        if (isFloating(a)) throw new Error(`client ${w} is floating — uncover_tiling works on the tiling layer`)
        const tag = String(a.tag)
        const content = parseRect(a.content_geometry)
        if (!content) throw new Error(`client ${w} has no content_geometry`)
        // focus W so hlwm's focused_frame points at its leaf frame
        await ctl(["hlwm", "jumpto", w])
        const frame = await frameOfClient(tag, w)
        if (!frame) throw new Error(`no leaf frame found for client ${w} on tag ${tag}`)

        const floats: { winid: string; rect: Rect }[] = []
        const clients = await allClients()
        for (const [id, ca] of Object.entries(clients)) {
          if (!isFloating(ca) || ca.tag !== tag) continue
          const r = parseRect(ca.decoration_geometry)
          if (r && overlaps(content, r)) floats.push({ winid: id, rect: r })
        }
        const before = rectStr(content)
        const result: UncoverResult = { action: "none", winid: w, frame: frame.path, before }
        if (floats.length === 0) {
          result.note = "no floating window overlaps the tiling window"
          return result
        }

        // Free rects within the tiling window's rect: partition the rect
        // against the obscuring floats' decorated frames.
        const { stdout } = await execFileAsync(
          "herbstclient",
          ["disjoin_rects", rectStr(content), ...floats.map((f) => rectStr(f.rect))],
          { timeout: 15_000, maxBuffer: 1024 * 1024 },
        )
        const rects: Rect[] = stdout.trim().split("\n").map(parseRect).filter((r): r is Rect => r !== null)
        const free = rects.filter((r) => !floats.some((f) => overlaps(r, f.rect)))
        if (free.length === 0) {
          result.action = "unsupported"
          result.note = "no free region inside the tiling window's rect"
          return result
        }
        const g = free.reduce((b, r) => (area(r) > area(b) ? r : b))
        // The largest free rect must be edge-aligned for a single split to
        // separate W from the floats. Interior floats need two splits —
        // documented as future work (see hlwm skill, section 7).
        const spansW = Math.abs(g.x - content.x) <= tol && Math.abs(g.x + g.w - (content.x + content.w)) <= tol
        const spansH = Math.abs(g.y - content.y) <= tol && Math.abs(g.y + g.h - (content.y + content.h)) <= tol
        let dir: "bottom" | "top" | "left" | "right"
        let fraction: number
        if (spansW && Math.abs(g.y - content.y) <= tol) {
          dir = "bottom" // free strip on top, float(s) below
          fraction = (g.y + g.h - content.y) / content.h
        } else if (spansW) {
          dir = "top" // free strip at bottom
          fraction = (g.y - content.y) / content.h
        } else if (spansH && Math.abs(g.x - content.x) <= tol) {
          dir = "right" // free strip on the left
          fraction = (g.x + g.w - content.x) / content.w
        } else if (spansH) {
          dir = "left" // free strip on the right
          fraction = (g.x - content.x) / content.w
        } else {
          result.action = "unsupported"
          result.note = `largest free rect ${rectStr(g)} does not span the frame edge — interior float needs a second split (future work)`
          return result
        }
        fraction = Math.min(0.95, Math.max(0.05, fraction))
        result.action = "split"
        result.split_direction = dir
        result.fraction = fraction

        // Focus W's frame and split.
        await ctl(["hlwm", "jumpto", w])
        await ctl(["hlwm", "split", dir, fraction.toFixed(4)])
        await ctl(["hlwm", "silent", "jumpto", w])
        let after = parseRect(JSON.parse(await ctl(["attrjson", `clients.${w}`, ".attributes.content_geometry"])))
        const stillCovered = (): boolean => {
          if (!after) return true
          return floats.some((f) => overlaps(after!, f.rect))
        }
        if (after && !stillCovered()) {
          result.after = rectStr(after)
          result.uncovered = true
          return result
        }
        // Recovery: float W, move frame focus to the neighbouring (free)
        // frame with cycle_frame, then unfloat — hlwm re-tiles into the
        // focused frame. polyframes tile would jump BACK into the vacated
        // covered frame, so it is deliberately not used here.
        result.action = "split+jump"
        await ctl(["hlwm", "silent", "attr", `clients.${w}.floating`, "true"])
        await ctl(["hlwm", "cycle_frame", "1"])
        await ctl(["hlwm", "silent", "attr", `clients.${w}.floating`, "false"])
        after = parseRect(JSON.parse(await ctl(["attrjson", `clients.${w}`, ".attributes.content_geometry"])))
        result.after = after ? rectStr(after) : null
        result.uncovered = !stillCovered()
        if (!result.uncovered) result.note = "split+jump did not free the window — inspect the frame tree manually"
        return result
      }

      /** The orchestrator's winid: persisted at first capture (presentation
       *  start, when the orchestrator TUI holds focus), or re-captured. */
      async function resolveOrchestrator(recapture = false): Promise<string> {
        if (!recapture) {
          try {
            const stored = (await readFile(ORCH_FILE, "utf8")).trim()
            if (stored !== "") return stored
          } catch { /* first capture */ }
        }
        const parsed = JSON.parse(await ctl(["attrjson", "clients.focus", ".attributes.winid"]))
        const winid = typeof parsed === "string" ? parsed : String(parsed)
        await mkdir(RUNTIME_DIR, { recursive: true })
        await writeFile(ORCH_FILE, winid)
        return winid
      }

      /** Persistent last-notification id for whisper replace. */
      const NOTIF_FILE = path.join(RUNTIME_DIR, "last-notif.id")
      async function lastNotifId(): Promise<string | null> {
        try {
          const v = (await readFile(NOTIF_FILE, "utf8")).trim()
          return v !== "" ? v : null
        } catch { return null }
      }

      tools.push(
        {
          name: "window_rect",
          description:
            "Geometry of one window with decorations accounted for: returns the decorated frame rect (what the audience sees), the client floating_geometry, and the deco margins (border/titlebar bleed). Use this before any placement math.",
          input: rectInput,
          execute: async (input: RectToolInput) => {
            const w = await resolveWinid(input.winid)
            const a: ClientAttrs = JSON.parse(
              await ctl([
                "attrjson", `clients.${w}`,
                ".attributes | {winid, tag, floating, floating_geometry, decoration_geometry}",
              ]),
            )
            const float = parseRect(a.floating_geometry)
            const deco = parseRect(a.decoration_geometry)
            const rects: ClientRects = {
              winid: String(a.winid ?? w), tag: typeof a.tag === "string" ? a.tag : null,
              floating: isFloating(a),
              floating_geometry: float, decoration_geometry: deco,
              deco_rect: deco ? rectStr(deco) : null,
              deco_margins: float && deco ? decoMargins(float, deco) : null,
            }
            return { content: JSON.stringify(rects) }
          },
        },
        {
          name: "query_disjoint_rects",
          description:
            "Partition the screen around a window using herbstclient disjoin_rects: pass the winid of the window you want to REPOSITION, and the tool feeds the monitor rect, the window's decorated rect, and the decorated rects of ALL currently floating windows into disjoin_rects, returning every partition rect annotated with which floating windows obscure it (obscured_by empty = safe slot for a non-obscuring presentation layout).",
          input: rectInput,
          execute: async (input: RectToolInput) => {
            const w = await resolveWinid(input.winid)
            return { content: JSON.stringify(await disjointPartition(w)) }
          },
        },
        {
          name: "largest_free_rect",
          description:
            "The largest-area partition rect (from query_disjoint_rects' computation) that is NOT obscured by any other floating window — the preferred slot for repositioning a floating window so nothing overlaps during a screencast. Returns rect: null when every rect is obscured.",
          input: rectInput,
          execute: async (input: RectToolInput) => {
            const w = await resolveWinid(input.winid)
            const part = await disjointPartition(w)
            const best = largestFree(part)
            return { content: JSON.stringify(best ? { winid: w, rect: best.rect, area: best.area } : { winid: w, rect: null }) }
          },
        },
        {
          name: "float_into",
          description:
            "Make a window floating and place it into a rect (hlwm 'WxH+X+Y' string, or omit the rect to use largest_free_rect). The client geometry is inset by the window's decoration margins so the DECORATED frame lands on the requested rect, then clamped deco-aware to the monitor. Overlaps are resolved by shrinking/moving unless shrink=false.",
          input: {
            type: "object",
            properties: {
              winid: { type: "string" },
              rect: { type: "string", description: "hlwm rect 'WxH+X+Y'; omit to auto-pick the largest free rect." },
              shrink: { type: "boolean", description: "Resolve residual overlaps by shrinking/moving (default true)." },
            },
            additionalProperties: false,
          },
          execute: async (input: { winid?: string; rect?: string; shrink?: boolean }) => {
            const w = await resolveWinid(input.winid)
            let want: Rect | null = parseRect(input.rect)
            if (!want) {
              const best = largestFree(await disjointPartition(w))
              if (!best) return { content: JSON.stringify({ winid: w, error: "no unobscured rect available" }) }
              want = parseRect(best.rect)
              if (!want) return { content: JSON.stringify({ winid: w, error: "unparseable free rect" }) }
            }
            const placed = await placeFloating(w, want, { shrink: input.shrink !== false, floats: await otherFloatRects(w) })
            return { content: JSON.stringify(placed) }
          },
        },
        {
          name: "fit_on_screen",
          description:
            "Nudge a floating window's position so its DECORATED frame fully fits on the focused monitor; if the frame is still bigger than the screen or still overlaps another floating window after the nudge, shrink the client (down to 200x150) until it clears. Returns before/after rects and any remaining overlaps.",
          input: rectInput,
          execute: async (input: RectToolInput) => {
            const w = await resolveWinid(input.winid)
            const beforeObj = (await allClients())[w]?.floating_geometry
            const before: RectStr | null = parseRect(beforeObj) ? rectStr(parseRect(beforeObj)!) : String(beforeObj ?? "")
            const cur = parseRect(beforeObj)
            if (!cur) return { content: JSON.stringify({ winid: w, error: "no floating_geometry (window not floating?)" }) }
            const placed = await placeFloating(w, cur, { shrink: false })
            let others = await otherFloatRects(w)
            const deco = parseRect(placed.deco)!
            let still = others.filter((f) => overlaps(deco, f.rect))
            let final = placed
            if (still.length > 0) {
              final = await placeFloating(w, parseRect(placed.floating_geometry)!, { shrink: true, floats: others })
              still = others.filter((f) => overlaps(parseRect(final.deco)!, f.rect))
            }
            return { content: JSON.stringify({ winid: w, before, after: final.floating_geometry, deco: final.deco, remaining_overlaps: still.map((s) => s.winid) }) }
          },
        },
        {
          name: "fit_floating_layer",
          description:
            "Iteratively fit the ENTIRE floating layer: every floating window (largest decorated frame first) is placed into its largest unobscured rect (see largest_free_rect), re-running passes until no two decorated frames overlap or the pass limit is hit. With lock=false (default) each placement is applied immediately with a short delay, so the audience sees the windows nudge into place; with lock=true the final layout is computed silently and applied in one shot inside herbstclient lock/unlock (windows snap at once).",
          input: {
            type: "object",
            properties: {
              lock: { type: "boolean", description: "Compute silently and snap all windows at once (default false)." },
              tag: { type: "string", description: "Restrict the fitting to one tag; default is the focused tag." },
              passes: { type: "number", description: "Max passes (default 4)." },
              delay_ms: { type: "number", description: "Pause between visible nudges (default 150)." },
            },
            additionalProperties: false,
          },
          execute: async (input: { lock?: boolean; tag?: string; passes?: number; delay_ms?: number }) => {
            const maxPasses = Math.max(1, Math.min(input.passes ?? 4, 12))
            const delay = Math.max(0, Math.min(input.delay_ms ?? 150, 2000))
            const tagFilter = typeof input.tag === "string" && input.tag !== "" ? input.tag : null

            interface LayerFloat { winid: string; rect: Rect; area: number }
            const grabFloats = async (): Promise<LayerFloat[]> => {
              const clients = await allClients()
              const floats: LayerFloat[] = []
              for (const [id, a] of Object.entries(clients)) {
                if (!isFloating(a)) continue
                if (tagFilter && a.tag !== tagFilter) continue
                const r = parseRect(a.decoration_geometry)
                if (r) floats.push({ winid: id, rect: r, area: r.w * r.h })
              }
              return floats
            }

            const placements: Record<string, RectStr> = {}
            /** One pass over the layer; `apply=false` simulates on the
             *  virtual state (for lock=true), `apply=true` also executes. */
            const runPass = async (apply: boolean): Promise<number> => {
              let moved = 0
              const floats = (await grabFloats()).sort((a, b) => b.area - a.area)
              const virt: { winid: string; rect: Rect; area: number }[] = floats.map((f) => ({ winid: f.winid, rect: f.rect, area: f.area }))
              const mon = await monitorRect()
              for (const f of floats) {
                const others = virt.filter((v) => v.winid !== f.winid)
                const { stdout } = await execFileAsync(
                  "herbstclient",
                  ["disjoin_rects", rectStr(mon), rectStr(f.rect), ...others.map((o) => rectStr(o.rect))],
                  { timeout: 15_000 },
                )
                const rects: Rect[] = stdout.trim().split("\n").map(parseRect).filter((r): r is Rect => r !== null)
                const free = rects.filter((r) => !others.some((o) => overlaps(r, o.rect)))
                if (free.length === 0) continue
                const best = free.reduce((b, r) => (area(r) > area(b) ? r : b))
                // Compute the clamped placement for the best slot, then accept
                // it only if it is on-screen, overlap-free and actually
                // different — a raw-area comparison would keep bogus states
                // (e.g. a deco frame hanging off-screen) "optimal" forever.
                const computed = await computePlacement(f.winid, best, { shrink: true, floats: others })
                const newDeco = parseRect(computed.deco)
                if (!newDeco) continue
                const onScreen =
                  newDeco.x >= mon.x && newDeco.y >= mon.y &&
                  newDeco.x + newDeco.w <= mon.x + mon.w &&
                  newDeco.y + newDeco.h <= mon.y + mon.h
                const clear = !others.some((o) => overlaps(newDeco, o.rect))
                if (!onScreen || !clear || rectStr(newDeco) === rectStr(f.rect)) continue
                if (apply) {
                  await ctl(["hlwm", "silent", "attr", `clients.${f.winid}.floating`, "true"])
                  await ctl(["hlwm", "silent", "attr", `clients.${f.winid}.floating_geometry`, computed.floating_geometry])
                }
                const placed: Placement = computed
                placements[f.winid] = placed.floating_geometry
                const pr = parseRect(placed.deco) ?? best
                const v = virt.find((x) => x.winid === f.winid)
                if (v) { v.rect = pr; v.area = area(pr) }
                moved++
                if (apply && delay > 0) await new Promise((res) => setTimeout(res, delay))
              }
              return moved
            }

            if (input.lock === true) {
              await ctl(["hlwm", "silent", "lock"])
              try {
                for (let i = 0; i < maxPasses; i++) if ((await runPass(false)) === 0) break
              } finally {
                for (const [w, geo] of Object.entries(placements)) {
                  await ctl(["hlwm", "silent", "attr", `clients.${w}.floating`, "true"])
                  await ctl(["hlwm", "silent", "attr", `clients.${w}.floating_geometry`, geo])
                }
                await ctl(["hlwm", "silent", "unlock"])
              }
            } else {
              for (let i = 0; i < maxPasses; i++) if ((await runPass(true)) === 0) break
            }
            return { content: JSON.stringify({ lock: input.lock === true, passes_run: maxPasses, placements }) }
          },
        },
        {
          name: "whisper",
          description:
            "One-way desktop notification to the user via notify-send (libnotify). Use when the user must be reached OUTSIDE the visible screencast windows — e.g. the agent is testing on a different tag while the conversation window is elsewhere, the audience needs a heads-up between scenes, or an error occurred that no visible window will show. Fire-and-forget; never blocks the performance.",
          input: {
            type: "object",
            properties: {
              text: { type: "string", description: "Notification body." },
              title: { type: "string", description: "Notification title (default 'opencode')." },
              urgency: { type: "string", enum: ["low", "normal", "critical"], description: "Default normal." },
              expire_ms: { type: "number", description: "Display duration in ms (0 = never expire; default server-defined)." },
            },
            required: ["text"],
            additionalProperties: false,
          },
          execute: async (input: { text: string; title?: string; urgency?: string; expire_ms?: number }) => {
            const args = ["-a", "opencode"]
            if (input.urgency) args.push("-u", input.urgency)
            if (typeof input.expire_ms === "number") args.push("-t", String(Math.max(0, Math.min(input.expire_ms, 60_000))))
            args.push(input.title && input.title.trim() !== "" ? input.title : "opencode", input.text)
            try {
              await execFileAsync("notify-send", args, { timeout: 10_000 })
              return { content: JSON.stringify({ delivered: true }) }
            } catch (err) {
              return { content: JSON.stringify({ delivered: false, error: String(err).slice(0, 200) }) }
            }
          },
        },
        {
          name: "stranded",
          description:
            "Audit whether the presentation's 'backstage' windows have been left behind: the OpenCode orchestrator window (captured at presentation start as the focused OpenCode window — multiple OpenCode windows may exist, so it is persisted to runtime state and only recaptured with recapture=true) and the floating narration window(s). Returns stranded=true when either is on a tag other than the user's currently focused tag, minimized, off-screen, or missing entirely. With notify=true, also whispers the summary to the user.",
          input: {
            type: "object",
            properties: {
              recapture: { type: "boolean", description: "Re-capture the orchestrator from the currently focused window." },
              notify: { type: "boolean", description: "Whisper a summary via notify-send when stranded (default false)." },
            },
            additionalProperties: false,
          },
          execute: async (input: { recapture?: boolean; notify?: boolean }) => {
            const mon = await monitorRect()
            const focusedTag = String(JSON.parse(await ctl(["attrjson", "tags.focus", ".attributes.name"])))

            // Orchestrator winid: durable, captured once at presentation start.
            const orchWinid = await resolveOrchestrator(input.recapture === true)

            const clients = await allClients()
            const assess = (a: ClientAttrs | undefined, label: string) => {
              if (!a) return { window: label, present: false, stranded: true, reasons: ["window not present"] }
              const reasons: string[] = []
              if (a.tag !== focusedTag) reasons.push(`on tag '${a.tag}', not the focused tag '${focusedTag}'`)
              if (a.minimized === true) reasons.push("minimized")
              const deco = parseRect(a.decoration_geometry)
              if (deco && (deco.x < mon.x || deco.y < mon.y ||
                deco.x + deco.w > mon.x + mon.w || deco.y + deco.h > mon.y + mon.h)) {
                reasons.push(`decorated frame ${rectStr(deco)} extends beyond the monitor ${rectStr(mon)}`)
              }
              return {
                window: label, winid: a.winid, present: true,
                stranded: reasons.length > 0, reasons,
                tag: a.tag ?? null, minimized: a.minimized === true,
                deco_rect: deco ? rectStr(deco) : null,
              }
            }

            const orchestrator = assess(clients[orchWinid], "orchestrator (OpenCode TUI)")
            const narration = Object.entries(clients)
              .filter(([, a]) => a.class === "ScreencastNarr")
              .map(([, a]) => assess(a, "narration"))
            const stranded = orchestrator.stranded || narration.some((n) => n.stranded)
            const summary: Record<string, unknown> = {
              stranded,
              focused_tag: focusedTag,
              monitor: rectStr(mon),
              orchestrator,
              narration_windows: narration,
            }
            if (stranded && input.notify === true) {
              const parts: string[] = []
              if (orchestrator.stranded) parts.push(`orchestrator: ${orchestrator.reasons.join("; ")}`)
              for (const n of narration) if (n.stranded) parts.push(`narration: ${n.reasons.join("; ")}`)
              await execFileAsync("notify-send", ["-a", "opencode", "-u", "normal", "opencode", `Stranded backstage: ${parts.join(" | ")}`], { timeout: 10_000 }).catch(() => undefined)
              summary.whispered = true
            }
            return { content: JSON.stringify(summary) }
          },
        },
        {
          name: "whisper",
          description:
            "One-way desktop notification to the user via dunstify/notify-send. Use when the user must be reached OUTSIDE the visible screencast windows — e.g. testing on another tag while the conversation window is elsewhere, demo asides, or errors no visible window shows. With replace=true the notification replaces the previous whisper (one stable slot, no notification spam). With rescue=true the notification carries a click action: when the user clicks it (or dismiss-activates it), the handler yoinks the view back to the tag holding the orchestrating OpenCode window (the whisper_rescue machinery). Actions fire in a detached handler — the tool returns immediately.",
          input: {
            type: "object",
            properties: {
              text: { type: "string", description: "Notification body." },
              title: { type: "string", description: "Notification title (default 'opencode')." },
              urgency: { type: "string", enum: ["low", "normal", "critical"], description: "Default normal." },
              expire_ms: { type: "number", description: "Display duration in ms (0 = never expire; rescue default 30000)." },
              replace: { type: "boolean", description: "Replace the previous whisper instead of stacking a new one." },
              rescue: { type: "boolean", description: "Attach a click action that jumps the user to the orchestrator's tag." },
              action_label: { type: "string", description: "Custom label for the rescue click action." },
            },
            required: ["text"],
            additionalProperties: false,
          },
          execute: async (input: { text: string; title?: string; urgency?: string; expire_ms?: number; replace?: boolean; rescue?: boolean; action_label?: string }) => {
            const env: Record<string, string> = {
              ...process.env as Record<string, string>,
              W_TITLE: input.title && input.title.trim() !== "" ? input.title : "opencode",
              W_TEXT: input.text,
              W_URGENCY: input.urgency ?? "normal",
              W_EXPIRE: String(typeof input.expire_ms === "number" ? Math.max(0, Math.min(input.expire_ms, 300_000)) : input.rescue === true ? 30_000 : 8000),
              W_LABEL: input.action_label && input.action_label.trim() !== "" ? input.action_label : "RESCUE: go to the OpenCode window",
              W_ORCH: "",
            }
            const replaceId = input.replace === true ? await lastNotifId() : null
            env.W_REPLACE = replaceId ?? ""
            if (input.rescue === true) env.W_ORCH = await resolveOrchestrator(false)
            // The handler: dunstify blocks until the notification expires or
            // the user activates the action (dunstify prints the id with -p,
            // then the invoked action key). 'default' fires on click; the
            // detached process then yoinks the view to the orchestrator.
            const script = [
              "out=$(dunstify -a opencode -u \"$W_URGENCY\" -t \"$W_EXPIRE\" -p \\",
              "  ${W_REPLACE:+-r \"$W_REPLACE\"} \\",
              "  ${W_ORCH:+-A \"default,$W_LABEL\"} \\",
              "  \"$W_TITLE\" \"$W_TEXT\") || exit 0",
              `printf '%s' \"$out\" > ${JSON.stringify(NOTIF_FILE)}`,
              "act=$(printf '%s' \"$out\" | tail -n1)",
              'if [ -n "$W_ORCH" ] && { [ "$act" = "default" ] || [ "$act" = "rescue" ]; }; then',
              "  herbstclient jumpto \"$W_ORCH\"",
              "fi",
            ].join("\n")
            let delivered = true
            let error: string | null = null
            try {
              const p = execFileAsync("bash", ["-c", script], { env, timeout: 320_000, maxBuffer: 1024 * 1024 })
              if (input.rescue === true) {
                p.catch(() => undefined) // detached handler: fires on click
              } else {
                await p // plain whisper: dunstify -p exits immediately with the id
              }
            } catch (err) {
              delivered = false
              error = String(err).slice(0, 200)
            }
            const id = await lastNotifId()
            return {
              content: JSON.stringify({
                delivered, error, id,
                replaced: input.replace === true && replaceId !== null,
                rescue_armed: input.rescue === true && delivered,
              }),
            }
          },
        },
        {
          name: "rescue",
          description:
            "Yoink the user's view (and focus) to the tag holding the orchestrating OpenCode window: herbstclient jumpto of the persisted orchestrator winid (captured at presentation start; captured from current focus if never persisted). The manual counterpart of the whisper(rescue=true) click action.",
          input: { type: "object", properties: {}, additionalProperties: false },
          execute: async () => {
            const orch = await resolveOrchestrator(false)
            await ctl(["hlwm", "jumpto", orch])
            const tag = JSON.parse(await ctl(["attrjson", "clients.focus", ".attributes.tag"]))
            return { content: JSON.stringify({ rescued: true, orchestrator: orch, tag: typeof tag === "string" ? tag : String(tag) }) }
          },
        },
        {
          name: "uncover_tiling",
          description:
            "Free a TILED window that is partially covered by floating window(s): computes the unobscured region inside the window's rect, creates a split on its frame whose boundary runs along the floating window's decorated edge (fraction derived from that edge, direction chosen so the client lands on the free side), verifies the window no longer intersects any float, and if it still does, performs the float -> cycle_frame -> unfloat jump into the free branch. Interior floats that touch no frame edge need a second split and are reported as unsupported.",
          input: {
            type: "object",
            properties: {
              winid: { type: "string", description: "Tiled client winid; omit for the focused window." },
              tolerance: { type: "number", description: "Edge-alignment tolerance in px (default 8)." },
            },
            additionalProperties: false,
          },
          execute: async (input: { winid?: string; tolerance?: number }) => {
            return { content: JSON.stringify(await uncoverTiling(input)) }
          },
        },
      )


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
          execute: async (input: unknown) => tool.execute(input as never),
        })
      }
    })

    await ctx.command.transform((editor) => {
      editor.add({
        name: "screencast",
        description: "Perform a screencast script (markdown) live on screen",
        execute: async ({ sessionID, prompt, delivery }) => {
          const script = prompt.text.trim()
          // Register the advance wiring: "advance" prompts are submitted to
          // this session, and after each advance focus returns to the
          // currently focused window (the orchestrating TUI at /screencast
          // time). The delegation panes' output watcher reads both.
          try {
            await ctl(["set-advance-session", sessionID])
          } catch {
            /* interception unavailable — TUI-message advance still works */
          }
          const contract = [
            "You are performing a LIVE screencast of herbstluftwm. The audience watches the screen; your narration appears in the floating narration window. The script drives everything. You perform it ONE SCENE PER TURN.",
            script ? `Script file: ${script} — read it with the read tool.` : "No script path was given; ask the user for one.",
            "",
            "SCENE definition: a scene is ONE narration paragraph plus everything between it and the next paragraph (code blocks and sleep directives). Scenes are performed strictly in file order.",
            "",
            `Per turn, perform exactly ONE scene:`,
            `1. Before the first scene: spawn the narration window (screencast_spawn_window, role=narration), then screencast_clear_window role=narration.`,
            "2. Narrate the scene's paragraph verbatim (screencast_narrate). The narration window also live-displays your hlwm operations automatically — never narrate or re-display them, and never write anything else to the narration window. The narration window is display-only; never focus it.",
            "3. Execute the scene's code blocks in order: hlwm → screencast_herbst per line (each operation auto-appears in the narration feed); ctl → run locally via bash; bash @session → screencast_delegate with session = annotation without @ (the audience sees the typing live); stage → screencast_stage with tag = the block's argument, then continue.",
            "4. Execute the scene's `sleep Ns`/`sleep Nms` directives with screencast_wait.",
            "5. END THE TURN immediately after one scene — except where the script's conventions declare a no-pause run-up (e.g. staging through the layout): perform those scenes consecutively, then pause. Never add your own commentary.",
            "",
            `ADVANCE PROTOCOL: after each scene the recording pauses. The user advances by sending any message in the TUI, OR by typing \`echo advance\` in a delegation terminal — the pane's output watcher forwards it to this session and returns focus to the TUI. Any new user message means: perform the NEXT scene, reading it from the file rather than from memory.`,
            "",
            "Begin now.",
          ].join("\n")
          await ctx.session.prompt({ sessionID, text: contract, delivery })
        },
      })
    })
  },
})
