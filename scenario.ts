/**
 * opencode-screencast — scenario layer (strongly typed OOP core).
 *
 * A Scenario is an author-time composition of Scenes. Each Scene records
 * Actions while executing them live, so a built scenario can be saved as a
 * replayable script file and later tweaked (delays, sounds, actions).
 *
 * The four primitives:
 *   Camera — the audience's view: which tag the monitor shows.
 *   Client — a managed window (narration, delegation, or any client).
 *   Scene  — one narrated beat: actions + camera moves + managed clients.
 *   User   — the human on the other side (EMPTY for now); configured with
 *            early-return guards and a fluent callback API in a later pass
 *            (dismissing windows, clicking notifications, running commands
 *            with regex-captured output in managed windows).
 */
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import path from "node:path"
import { mkdir, readFile, writeFile } from "node:fs/promises"

const execFileAsync = promisify(execFile)
export { execFileAsync }

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/** A herbstluftwm window id, "0x…" — branded so raw strings don't leak in. */
declare const winIdBrand: unique symbol
export type WinId = string & { readonly [winIdBrand]: "WinId" }
export const winId = (s: string): WinId => {
  if (!/^0x[0-9a-fA-F]+$/.test(s)) throw new Error(`not a winid: ${s}`)
  return s as WinId
}

/** A herbstluftwm tag name. */
declare const tagBrand: unique symbol
export type TagName = string & { readonly [tagBrand]: "Tag" }
export const tagName = (s: string): TagName => {
  if (s.trim() === "" || /\s/.test(s)) throw new Error(`not a tag name: '${s}'`)
  return s as TagName
}

/** Geometry rect in screen coordinates. */
export interface Rect {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

/** Placeholder for later tweaking (beeps, chimes, narration dings). */
export type Sound =
  | { readonly kind: "none" }
  | { readonly kind: "beep"; readonly frequency?: number; readonly durationMs?: number }

// ---------------------------------------------------------------------------
// Serialized replay format (v1)
// ---------------------------------------------------------------------------

export interface ActionBase {
  readonly at: number // ms offset from scene start, for replay pacing
}
export type SceneAction =
  | (ActionBase & { readonly t: "narrate"; readonly text: string })
  | (ActionBase & { readonly t: "wait"; readonly ms: number; readonly sound?: Sound })
  | (ActionBase & { readonly t: "whisper"; readonly text: string; readonly title?: string; readonly replace?: boolean; readonly rescue?: boolean })
  | (ActionBase & { readonly t: "camera_focus"; readonly tag: TagName })
  | (ActionBase & { readonly t: "camera_follow"; readonly winid: WinId; readonly winTag?: TagName })
  | (ActionBase & { readonly t: "spawn_window"; readonly role: "narration" | "command"; readonly session?: string })
  | (ActionBase & { readonly t: "run"; readonly command: string; readonly session?: string; readonly capture?: CaptureSpec })
  | (ActionBase & { readonly t: "client_float"; readonly winid: WinId; readonly rect?: Rect })
  | (ActionBase & { readonly t: "client_tile"; readonly winid: WinId })
  | (ActionBase & { readonly t: "client_move"; readonly winid: WinId; readonly tag: TagName; readonly fromTag?: TagName })
  | (ActionBase & { readonly t: "client_close"; readonly winid: WinId })
  | (ActionBase & { readonly t: "client_minimize"; readonly winid: WinId })
  | (ActionBase & { readonly t: "user_await"; readonly expect: string; readonly timeoutMs: number; readonly ok: boolean; readonly recovered?: boolean })
  | (ActionBase & { readonly t: "user_expect"; readonly expect: string; readonly ok: boolean })
  | (ActionBase & { readonly t: "user_recover"; readonly strategy: string })
  | (ActionBase & { readonly t: "oneshot_spawn"; readonly session: string; readonly command: string })
  | (ActionBase & { readonly t: "free_run"; readonly session: string; readonly command: string; readonly captured?: boolean })
  | (ActionBase & { readonly t: "actor_watch"; readonly session: string; readonly pattern: string; readonly message: string; readonly onCloseMessage?: string })

/** Regex capture of managed-window output, resolved into named groups. */
export interface CaptureSpec {
  readonly pattern: string // ECMAScript regex source
  readonly groups: readonly string[] // named capture groups to expose
}

export interface SceneSpec {
  readonly name: string
  readonly actions: readonly SceneAction[]
}

export interface ScenarioSpec {
  readonly version: 1
  readonly title: string
  readonly created: string
  readonly scenes: readonly SceneSpec[]
}

// ---------------------------------------------------------------------------
// Low-level bridge (same contract as index.ts uses via screencastctl)
// ---------------------------------------------------------------------------

export type Ctl = (args: readonly string[], timeoutMs?: number) => Promise<string>

let lastNotifId: string | null = null

/** Parse a hlwm rect literal "WxH+X+Y" (offsets may be negative). */
export const parseRect = (s: string): Rect => {
  const m = s.trim().match(/^(\d+)x(\d+)([+-]\d+)([+-]\d+)$/)
  if (!m) throw new Error(`unparseable rect: ${s}`)
  return { w: +m[1], h: +m[2], x: +m[3], y: +m[4] }
}
export const rectStr = (r: Rect): string => `${r.w}x${r.h}+${r.x}+${r.y}`
export const overlaps = (a: Rect, b: Rect): boolean =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

// ---------------------------------------------------------------------------
// Backprop checker — flags back-and-forth state churn before it hits the
// screen. Walks the action stream forward maintaining a simulated state
// (camera tag, per-window tag/float state) and reports every action whose
// effect is redundant, reversed, or contradicts the intent of a recent
// action. "Backprop-style": each action is evaluated against the state the
// PRECEDING actions produced, so an accidental `camera_follow` onto a
// previous workspace is caught as a reversal of the last camera move.
// ---------------------------------------------------------------------------

const LOOKBACK = 4 // actions within which a reversal counts as churn

export type IssueKind = "duplicate" | "yo-yo" | "undo-pair" | "oscillation"

export interface ScenarioIssue {
  readonly kind: IssueKind
  readonly scene: string
  readonly index: number
  readonly description: string
}

export class BackpropChecker {
  /** Analyze one scene's actions; pure — no side effects, no shared state. */
  static analyze(sceneName: string, actions: readonly SceneAction[]): ScenarioIssue[] {
    const issues: ScenarioIssue[] = []
    let camTag: string | null = null
    let lastCamIndex = -1
    let lastCamDesc = ""
    let lastFollowedWinid: string | undefined
    const winTag = new Map<string, string>()
    const lastMoveIndex = new Map<string, number>()
    const winFloat = new Map<string, boolean>()
    const lastFloatToggle = new Map<string, number>()
    const winGone = new Set<string>()
    let lastWhisper: string | null = null

    actions.forEach((a, i) => {
      switch (a.t) {
        case "camera_focus": {
          if (camTag === a.tag) {
            issues.push({ kind: "duplicate", scene: sceneName, index: i,
              description: `camera_focus('${a.tag}') repeats the current view — no camera change (previous camera action #${lastCamIndex}: ${lastCamDesc})` })
          } else {
            camTag = a.tag
            lastCamIndex = i
            lastCamDesc = `camera_focus('${a.tag}')`
          }
          break
        }
        case "camera_follow": {
          const wt = a.winTag ?? winTag.get(a.winid)
          if (wt !== undefined) {
            if (a.winid === lastFollowedWinid && wt === camTag) {
              issues.push({ kind: "duplicate", scene: sceneName, index: i,
                description: `camera_follow('${a.winid}') repeats the previous follow — the camera is already on '${wt}' with that window focused` })
            } else if (a.winid !== lastFollowedWinid && wt !== camTag) {
              issues.push({ kind: "yo-yo", scene: sceneName, index: i,
                description: `camera_follow('${a.winid}') jumps from '${camTag}' to '${wt}' — the window lives on a PREVIOUS workspace (last camera action #${lastCamIndex}: ${lastCamDesc}); likely an accidental focus` })
            }
          }
          if (wt !== undefined) { camTag = wt; winTag.set(a.winid, wt) }
          lastCamIndex = i
          lastCamDesc = `camera_follow('${a.winid}')`
          lastFollowedWinid = a.winid
          break
        }
        case "client_move": {
          const prev = a.fromTag ?? winTag.get(a.winid)
          if (prev === a.tag) {
            issues.push({ kind: "duplicate", scene: sceneName, index: i,
              description: `client_move('${a.winid}', '${a.tag}') — window already on that tag` })
          } else {
            const lastMoveTarget = winTag.get(a.winid)
            const lm = lastMoveIndex.get(a.winid)
            if (lastMoveTarget !== undefined && prev !== undefined && prev === lastMoveTarget && lm !== undefined && i - lm <= LOOKBACK) {
              issues.push({ kind: "undo-pair", scene: sceneName, index: i,
                description: `client_move('${a.winid}', '${a.tag}') returns the window to '${a.tag}' within ${LOOKBACK} actions of moving it away — window shuffling (screen flash)` })
            }
            winTag.set(a.winid, a.tag)
            lastMoveIndex.set(a.winid, i)
          }
          break
        }
        case "client_float": {
          const wasFloat = winFloat.get(a.winid) ?? false
          if (wasFloat) {
            issues.push({ kind: "duplicate", scene: sceneName, index: i,
              description: `client_float('${a.winid}') — window is already floating` })
          } else if (i - (lastFloatToggle.get(a.winid) ?? -99) <= LOOKBACK) {
            issues.push({ kind: "oscillation", scene: sceneName, index: i,
              description: `client_float('${a.winid}') within ${LOOKBACK} actions of its last float/tile — floating-layer churn (screen flash)` })
          }
          winFloat.set(a.winid, true)
          lastFloatToggle.set(a.winid, i)
          break
        }
        case "client_tile": {
          const wasFloat = winFloat.get(a.winid) ?? true
          if (!wasFloat) {
            issues.push({ kind: "duplicate", scene: sceneName, index: i,
              description: `client_tile('${a.winid}') — window is already tiled` })
          } else if (i - (lastFloatToggle.get(a.winid) ?? -99) <= LOOKBACK) {
            issues.push({ kind: "oscillation", scene: sceneName, index: i,
              description: `client_tile('${a.winid}') within ${LOOKBACK} actions of its last float/tile — floating-layer churn (screen flash)` })
          }
          winFloat.set(a.winid, false)
          lastFloatToggle.set(a.winid, i)
          break
        }
        case "client_close":
        case "client_minimize": {
          if (a.t === "client_close" && winGone.has(a.winid)) {
            issues.push({ kind: "duplicate", scene: sceneName, index: i,
              description: `client_close('${a.winid}') — window was already closed` })
          }
          if (a.t === "client_close") winGone.add(a.winid)
          break
        }
        case "whisper": {
          const key = `${a.title ?? "opencode"}::${a.text}`
          if (key === lastWhisper && a.replace !== true) {
            issues.push({ kind: "duplicate", scene: sceneName, index: i,
              description: "identical whisper repeated without replace — use replace: true to update the existing slot" })
          }
          lastWhisper = key
          break
        }
        default:
          break
      }
    })
    return issues
  }
}

// User — the human on the other side. Test-framework verbs: expect/await/
// recover. Built on OBSERVABLE STATE (hlwm primitives + command results),
// never on blind sleeps: an expectation is a predicate over the world that
// is polled until it holds — and when it fails, a recovery strategy gets a
// chance to fix the world before the scenario gives up.
// ---------------------------------------------------------------------------

/** A predicate over observable state. Pure-ish: `check` only reads. */
export interface Expectation {
  /** Human-readable description (also what gets recorded for replay). */
  readonly describe: string
  check: (ctl: Ctl) => Promise<boolean>
}

export type RecoveryStrategy = (ctx: { readonly expectation: string; readonly ctl: Ctl }) => Promise<void> | void

export interface AwaitOpts {
  readonly timeoutMs?: number // default 15000
  readonly pollMs?: number // default 250
  /** Overrides any user.recover() default for this single await. */
  readonly recover?: RecoveryStrategy
}

export class ExpectationFailed extends Error {
  constructor(readonly expectation: string) {
    super(`expectation failed: ${expectation}`)
    this.name = "ExpectationFailed"
  }
}

// --- expectation builders over hlwm primitives -----------------------------

const readAttr = async (ctl: Ctl, objPath: string): Promise<Record<string, unknown> | null> => {
  try {
    return JSON.parse(await ctl(["attrjson", objPath, ".attributes"]))
  } catch {
    return null // missing object/window — an observable state, not an error
  }
}

export const expectTag = (tag: TagName): Expectation => ({
  describe: `current tag is '${tag}'`,
  check: async (ctl) => (await readAttr(ctl, "tags.focus"))?.name === tag,
})

export const expectTagNot = (tag: TagName): Expectation => ({
  describe: `current tag is NOT '${tag}'`,
  check: async (ctl) => (await readAttr(ctl, "tags.focus"))?.name !== tag,
})

export const expectFocus = (winid: WinId): Expectation => ({
  describe: `focused window is ${winid}`,
  check: async (ctl) => (await readAttr(ctl, "clients.focus"))?.winid === winid,
})

export const expectFocusTitle = (re: RegExp): Expectation => ({
  describe: `focused window title matches ${String(re)}`,
  check: async (ctl) => {
    const title = (await readAttr(ctl, "clients.focus"))?.title
    return typeof title === "string" && re.test(title)
  },
})

export const expectWindow = (winid: WinId, present = true): Expectation => ({
  describe: `window ${winid} is ${present ? "present" : "gone"}`,
  check: async (ctl) => present
    ? (await readAttr(ctl, `clients.${winid}`)) !== null
    : (await readAttr(ctl, `clients.${winid}`)) === null,
})

export const expectFloating = (winid: WinId, floating = true): Expectation => ({
  describe: `window ${winid} is ${floating ? "floating" : "tiled"}`,
  check: async (ctl) => (await readAttr(ctl, `clients.${winid}`))?.floating === floating,
})

export const expectMinimized = (winid: WinId, minimized = true): Expectation => ({
  describe: `window ${winid} is ${minimized ? "minimized" : "visible"}`,
  check: async (ctl) => (await readAttr(ctl, `clients.${winid}`))?.minimized === minimized,
})

/** Rect constraints: size bounds and/or required overlap with an anchor rect. */
export interface RectBounds {
  readonly minWidth?: number
  readonly minHeight?: number
  readonly maxWidth?: number
  readonly maxHeight?: number
  /** The decorated frame must intersect this rect (e.g. "still where I care about"). */
  readonly intersecting?: Rect
}
export const expectRect = (winid: WinId, b: RectBounds): Expectation => ({
  describe: `window ${winid} rect within bounds {${b.minWidth ?? "-"}x${b.minHeight ?? "-"} .. ${b.maxWidth ?? "-"}x${b.maxHeight ?? "-"}${b.intersecting ? `, intersecting ${rectStr(b.intersecting)}` : ""}}`,
  check: async (ctl) => {
    const raw = await readAttr(ctl, `clients.${winid}`)
    if (raw === null) return false
    const g = raw.decoration_geometry
    if (typeof g !== "object" || g === null) return false
    const rec = g as Record<string, unknown>
    const r: Rect = { x: Number(rec.x), y: Number(rec.y), w: Number(rec.width), h: Number(rec.height) }
    if (![r.x, r.y, r.w, r.h].every(Number.isFinite)) return false
    if (b.minWidth !== undefined && r.w < b.minWidth) return false
    if (b.minHeight !== undefined && r.h < b.minHeight) return false
    if (b.maxWidth !== undefined && r.w > b.maxWidth) return false
    if (b.maxHeight !== undefined && r.h > b.maxHeight) return false
    if (b.intersecting && !overlaps(r, b.intersecting)) return false
    return true
  },
})

// --- command observables (screencastctl task pipeline) ---------------------

interface TaskStatus { state: string; exit: string | null; output: string }

const taskStatus = async (ctl: Ctl, session: string): Promise<TaskStatus | null> => {
  let raw: string
  try {
    raw = await ctl(["task-status", session])
  } catch {
    return null
  }
  let state = "absent"
  let exit: string | null = null
  let output = ""
  for (const line of raw.split("\n")) {
    if (line.startsWith("STATE ")) state = line.slice(6).trim()
    else if (line.startsWith("EXIT ")) exit = line.slice(5).trim() === "-" ? null : line.slice(5).trim()
    else if (line.startsWith("OUTPUT ")) {
      const v = line.slice(7).trim()
      if (v !== "-") { try { output = Buffer.from(v, "base64").toString("utf8") } catch { /* ignore */ } }
    }
  }
  return { state, exit, output }
}

export const expectTaskState = (session: string, state: "absent" | "running" | "done" | "lost"): Expectation => ({
  describe: `task '${session}' state is '${state}'`,
  check: async (ctl) => (await taskStatus(ctl, session))?.state === state,
})

export const expectTaskExit = (session: string, exitCode: number): Expectation => ({
  describe: `task '${session}' exited with code ${exitCode}`,
  check: async (ctl) => (await taskStatus(ctl, session))?.exit === String(exitCode),
})

/** Command produced output matching a regex. */
export const expectTaskOutput = (session: string, re: RegExp): Expectation => ({
  describe: `task '${session}' output matches ${String(re)}`,
  check: async (ctl) => {
    const t = await taskStatus(ctl, session)
    return t !== null && re.test(t.output)
  },
})

// --- recovery strategies -----------------------------------------------------

const USER_ORCH_FILE = path.join(process.env.XDG_RUNTIME_DIR || "/tmp/opencode", "screencast", "orchestrator.winid")

/** Focus was stolen (user clicked elsewhere, a dialog grabbed focus): yoink
 *  the camera back to the orchestrating OpenCode window. */
export const recoverFocus = (): RecoveryStrategy => async ({ ctl }) => {
  let orch = ""
  try { orch = (await readFile(USER_ORCH_FILE, "utf8")).trim() } catch { orch = "" }
  if (orch !== "") await ctl(["hlwm", "jumpto", orch])
}

/** Run an arbitrary corrective action (close a stray dialog, re-float...). */
export const recoverBy = (describe: string, fn: (ctl: Ctl) => Promise<void> | void): RecoveryStrategy => {
  const s = async ({ ctl }: { readonly expectation: string; readonly ctl: Ctl }): Promise<void> => { await fn(ctl) }
  Object.defineProperty(s, "name", { value: describe })
  return s
}

// --- the fluent User surface -------------------------------------------------

export interface UserOpsInit {
  readonly ctl: Ctl
  readonly record: (action: SceneAction) => void
}

export class UserOps {
  private defaultRecover: RecoveryStrategy | null = null

  constructor(private readonly init: UserOpsInit) {}

  /** Register the default recovery for all subsequent awaits (fluent). */
  recover(strategy: RecoveryStrategy, label?: string): this {
    this.defaultRecover = strategy
    this.init.record({ t: "user_recover", strategy: label ?? strategy.name ?? "recovery", at: 0 })
    return this
  }

  /**
   * Wait until an expectation holds. On failure, runs the recovery
   * strategy (explicit or default) once and re-checks — early-return
   * style: a failed expectation degrades to recovery instead of crashing
   * the performance; only exhausted recovery throws.
   */
  async await(expectation: Expectation, opts: AwaitOpts = {}): Promise<this> {
    const timeoutMs = opts.timeoutMs ?? 15_000
    const pollMs = opts.pollMs ?? 250
    let deadline = Date.now() + timeoutMs
    let recovered = false
    for (;;) {
      if (await expectation.check(this.init.ctl)) {
        this.init.record({ t: "user_await", expect: expectation.describe, timeoutMs, ok: true, ...(recovered ? { recovered: true } : {}), at: 0 })
        return this
      }
      if (Date.now() >= deadline) {
        const strategy = opts.recover ?? this.defaultRecover
        if (recovered || strategy === null || strategy === undefined) {
          this.init.record({ t: "user_await", expect: expectation.describe, timeoutMs, ok: false, at: 0 })
          throw new ExpectationFailed(expectation.describe)
        }
        recovered = true
        await strategy({ expectation: expectation.describe, ctl: this.init.ctl })
        deadline = Date.now() + timeoutMs // one recovery grant: fresh deadline
        continue
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs))
    }
  }

  /**
   * Strict form: the expectation must hold within a short grace period,
   * NO recovery. Throws ExpectationFailed — for invariants, not for
   * waiting on the human.
   */
  async expect(expectation: Expectation, graceMs = 1000): Promise<this> {
    const deadline = Date.now() + graceMs
    for (;;) {
      if (await expectation.check(this.init.ctl)) {
        this.init.record({ t: "user_expect", expect: expectation.describe, ok: true, at: 0 })
        return this
      }
      if (Date.now() >= deadline) {
        this.init.record({ t: "user_expect", expect: expectation.describe, ok: false, at: 0 })
        throw new ExpectationFailed(expectation.describe)
      }
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
  }

  /**
   * The human advances the scenario by activating a notification (click /
   * dunst action). Blocks until clicked or expired; on timeout the
   * recovery strategy runs (e.g. recoverFocus) and ExpectationFailed is
   * thrown — the scenario author decides whether that is fatal.
   */
  async awaitClick(text: string, opts: { title?: string; timeoutMs?: number; recover?: RecoveryStrategy } = {}): Promise<this> {
    const timeoutMs = opts.timeoutMs ?? 60_000
    const args = ["-a", "opencode", "-u", "normal", "-t", String(timeoutMs), "-A", "default,Advance", "-p", opts.title ?? "opencode", text]
    let clicked = false
    try {
      const out = (await execFileAsync("dunstify", args, { timeout: timeoutMs + 5000 })).stdout.trim()
      const action = out.split("\n").pop()?.trim()
      clicked = action === "default"
    } catch {
      clicked = false // notification channel down or timeout — treat as no click
    }
    this.init.record({ t: "user_await", expect: `user clicked the notification '${text.slice(0, 40)}'`, timeoutMs, ok: clicked, at: 0 })
    if (!clicked) {
      const strategy = opts.recover ?? this.defaultRecover
      if (strategy !== null && strategy !== undefined) await strategy({ expectation: "notification click", ctl: this.init.ctl })
      throw new ExpectationFailed(`user did not click the notification: '${text.slice(0, 40)}'`)
    }
    return this
  }

  /** Combinators (test-framework style). */
  static all(...expectations: readonly Expectation[]): Expectation {
    return {
      describe: `all of [${expectations.map((e) => e.describe).join("; ")}]`,
      check: async (ctl) => {
        for (const e of expectations) if (!(await e.check(ctl))) return false
        return true
      },
    }
  }
  static any(...expectations: readonly Expectation[]): Expectation {
    return {
      describe: `any of [${expectations.map((e) => e.describe).join("; ")}]`,
      check: async (ctl) => {
        for (const e of expectations) if (await e.check(ctl)) return true
        return false
      },
    }
  }
  static not(expectation: Expectation): Expectation {
    return { describe: `not (${expectation.describe})`, check: async (ctl) => !(await expectation.check(ctl)) }
  }
}

export type User = UserOps

// ---------------------------------------------------------------------------
// Orchestrator / Narration / Terminals — the cast of a presentation.
// ---------------------------------------------------------------------------

/** Does this title belong to an OpenCode TUI window? (Class is useless —
 *  OpenCode runs in alacritty like everything else; the title is the only
 *  stable discriminator, and it CHURNWinIds: ids are recycled on reopen.) */
export const isOpenCodeTitle = (title: string): boolean => /^OC /.test(title)

/** Winids that must never be closed/minimized by scenario actions. */
export const isProtectedTitle = (title: string): boolean =>
  isOpenCodeTitle(title) || title.startsWith("screencast:")

/**
 * The orchestrating OpenCode chat — the conversation this scenario runs
 * from. Its winid CHURNS when the window is reopened, so identity comes
 * from CAPTURE AT SCENARIO START: the focused window's winid is grabbed
 * when the first scene opens (and persisted). `current()` re-resolves:
 * persisted id if still alive, else a fresh capture from focus — NEVER a
 * title guess. (The title prefix check lives only in the close guard as
 * an extra safety net.)
 */
export class Orchestrator {
  private constructor(
    readonly id: WinId,
    private readonly ctl: Ctl,
  ) {}

  /** Grab the focused window's winid NOW and persist it. */
  static async capture(ctl: Ctl): Promise<Orchestrator> {
    const parsed = JSON.parse(await ctl(["attrjson", "clients.focus", ".attributes.winid"]))
    const id = winId(typeof parsed === "string" ? parsed : String(parsed))
    await mkdir(path.dirname(USER_ORCH_FILE), { recursive: true })
    await writeFile(USER_ORCH_FILE, id)
    return new Orchestrator(id, ctl)
  }

  /** Persisted id if the client is alive; otherwise a fresh capture. */
  static async current(ctl: Ctl): Promise<Orchestrator> {
    let stored = ""
    try {
      stored = (await readFile(USER_ORCH_FILE, "utf8")).trim()
    } catch { /* no capture yet */ }
    if (stored !== "") {
      const a = await readAttr(ctl, `clients.${stored}`)
      if (a !== null && typeof a.winid === "string") return new Orchestrator(winId(String(a.winid)), ctl)
    }
    return Orchestrator.capture(ctl)
  }

  async title(): Promise<string | null> {
    const a = await readAttr(this.ctl, `clients.${this.id}`)
    return typeof a?.title === "string" ? a.title : null
  }

  async tag(): Promise<TagName | null> {
    const a = await readAttr(this.ctl, `clients.${this.id}`)
    return typeof a?.tag === "string" ? tagName(a.tag) : null
  }

  async focus(): Promise<this> {
    await this.ctl(["hlwm", "jumpto", this.id])
    return this
  }
}

/** The audience-facing narration window (class ScreencastNarr). */
export class Narration {
  private constructor(
    readonly id: WinId,
    private readonly ctl: Ctl,
    private readonly record: (action: SceneAction) => void,
  ) {}

  static async find(ctl: Ctl): Promise<Narration | null> {
    const raw = await ctl(["attrjson", "clients", "[.children[] | select(. != \"focus.\") | sub(\"\\\\.$\"; \"\")]"])
    const winids: string[] = JSON.parse(raw)
    for (const w of winids) {
      const a = await readAttr(ctl, `clients.${w}`)
      if (a !== null && a.class === "ScreencastNarr") return new Narration(winId(String(a.winid ?? w)), ctl, () => undefined)
    }
    return null
  }

  static async spawn(ctl: Ctl, record: (action: SceneAction) => void): Promise<Narration> {
    await ctl(["spawn", "narration"])
    const n = await Narration.find(ctl)
    if (n === null) throw new Error("narration window did not appear")
    void record
    return new Narration(n.id, ctl, record)
  }

  async say(text: string): Promise<this> {
    await this.ctl(["say", text])
    return this
  }

  async clear(): Promise<this> {
    await this.ctl(["clear", "narration"])
    return this
  }

  async rect(): Promise<Rect> {
    const a = await readAttr(this.ctl, `clients.${this.id}`)
    const g = a?.decoration_geometry
    if (typeof g !== "object" || g === null) throw new Error("narration has no geometry")
    const rec = g as Record<string, unknown>
    return { x: Number(rec.x), y: Number(rec.y), w: Number(rec.width), h: Number(rec.height) }
  }
}

// --- terminals --------------------------------------------------------------

const RUNTIME = path.join(process.env.XDG_RUNTIME_DIR || "/tmp/opencode", "screencast")

interface TerminalInit {
  readonly session: string
  readonly winid: WinId | null
  readonly ctl: Ctl
}

/**
 * A window that runs EXACTLY ONE command; on its completion it runs
 * `~/.local/bin/pause` (self-titled "⏸ paused — press any key"), and when
 * pause exits (keypress in the terminal) the window closes itself. Exit
 * code observable via expectTaskExit — completion is recorded even after
 * the window is gone.
 */
export class PauseTerminal {
  private constructor(private readonly t: TerminalInit) {}

  get session(): string { return this.t.session }
  /** The floating window's id — resolved after spawn; null once closed. */
  get winid(): WinId | null { return this.t.winid }

  static async spawn(ctl: Ctl, command: string, opts: { session?: string } = {}): Promise<PauseTerminal> {
    const session = opts.session ?? `oneshot-${Date.now() % 100000}`
    const before = new Set<string>(JSON.parse(await ctl(["attrjson", "clients", "[.children[] | select(. != \"focus.\") | sub(\"\\\\.$\"; \"\")]"])))
    await ctl(["spawn-oneshot", session, command])
    // resolve the new window: the freshest ScreencastCmd client we didn't see before
    let winid: WinId | null = null
    for (let i = 0; i < 20; i++) {
      const now: string[] = JSON.parse(await ctl(["attrjson", "clients", "[.children[] | select(. != \"focus.\") | sub(\"\\\\.$\"; \"\")]"]))
      const fresh = now.filter((w) => !before.has(w))
      if (fresh.length > 0) {
        for (const w of fresh) {
          const a = await readAttr(ctl, `clients.${w}`)
          if (a !== null && a.class === "ScreencastCmd") { winid = winId(String(a.winid ?? w)); break }
        }
        if (winid !== null) break
      }
      await new Promise((r) => setTimeout(r, 150))
    }
    return new PauseTerminal({ session, winid, ctl })
  }

  /** Wait for the command to finish (pause NOT included). */
  async awaitExit(opts: AwaitOpts = {}): Promise<this> {
    const deadline = Date.now() + (opts.timeoutMs ?? 60_000)
    for (;;) {
      const raw = await this.t.ctl(["task-status", this.t.session]).catch(() => "")
      if (/^STATE done/m.test(raw)) return this
      if (/^STATE lost/m.test(raw)) throw new ExpectationFailed(`oneshot '${this.t.session}' was closed before finishing`)
      if (Date.now() > deadline) throw new ExpectationFailed(`oneshot '${this.t.session}' did not finish in time`)
      await new Promise((r) => setTimeout(r, opts.pollMs ?? 300))
    }
  }

  /** Wait for the window to vanish — the pause keypress happened. */
  async awaitClosed(opts: AwaitOpts = {}): Promise<this> {
    const deadline = Date.now() + (opts.timeoutMs ?? 120_000)
    for (;;) {
      if (this.t.winid === null) return this
      const a = await readAttr(this.t.ctl, `clients.${this.t.winid}`)
      if (a === null) return this
      if (Date.now() > deadline) throw new ExpectationFailed(`oneshot window did not close in time`)
      await new Promise((r) => setTimeout(r, opts.pollMs ?? 400))
    }
  }
}

/**
 * A free, interactable terminal: multiple commands can run, output is
 * teed to a persistent log in /tmp (runtime dir), and the scenario can
 * advance upon detecting a regex in the output. The operator may close
 * the window (keybind) or end-of-input it (Ctrl-D) at any time — the
 * terminal "loses the handle": further runs fail gracefully.
 */
export class FreeTerminal {
  private constructor(
    readonly session: string,
    private readonly winid: WinId | null,
    private readonly ctl: Ctl,
    private readonly record: (action: SceneAction) => void,
    private logFile: string,
  ) {}

  static async spawn(ctl: Ctl, record: (action: SceneAction) => void, session = "free-terminal"): Promise<FreeTerminal> {
    const before = new Set<string>(JSON.parse(await ctl(["attrjson", "clients", "[.children[] | select(. != \"focus.\") | sub(\"\\\\.$\"; \"\")]"])))
    await ctl(["spawn", "command", session])
    let winid: WinId | null = null
    for (let i = 0; i < 20; i++) {
      const now: string[] = JSON.parse(await ctl(["attrjson", "clients", "[.children[] | select(. != \"focus.\") | sub(\"\\\\.$\"; \"\")]"]))
      for (const w of now.filter((x) => !before.has(x))) {
        const a = await readAttr(ctl, `clients.${w}`)
        if (a !== null && a.class === "ScreencastCmd") { winid = winId(String(a.winid ?? w)); break }
      }
      if (winid !== null) break
      await new Promise((r) => setTimeout(r, 150))
    }
    const logFile = path.join(RUNTIME, `${session}.output.log`)
    return new FreeTerminal(session, winid, ctl, record, logFile)
  }

  /** Type a command into the window and collect its new output. */
  async run(command: string): Promise<string> {
    if (this.detached) throw new ExpectationFailed(`free terminal '${this.session}' was detached — no handle`)
    const out = await this.ctl(["run", this.session, command])
    this.record({ t: "free_run", session: this.session, command, at: 0 })
    return out
  }

  /** Resolve when the log matches a regex — advance-the-presentation hook. */
  async awaitOutput(re: RegExp, opts: { timeoutMs?: number; pollMs?: number } = {}): Promise<string> {
    const deadline = Date.now() + (opts.timeoutMs ?? 60_000)
    let offset = 0
    for (;;) {
      let tail = ""
      try { tail = (await readFile(this.logFile, "utf8")).slice(offset) } catch { tail = "" }
      const m = tail.match(re)
      if (m) return m[0]
      if (Date.now() > deadline) throw new ExpectationFailed(`output of '${this.session}' never matched ${String(re)}`)
      offset = Math.max(0, (await readFile(this.logFile, "utf8").catch(() => "")).length - 4096)
      await new Promise((r) => setTimeout(r, opts.pollMs ?? 400))
    }
  }

  private detached = false

  /** Lose the handle: the window stays, the operator owns it from here. */
  detach(): this {
    this.detached = true
    return this
  }

  /**
   * Register a condition→message callback (the codified "advance" bridge):
   * when NEW output of this window matches `match`, the watcher submits
   * `message` into the orchestrating opencode session (advance.sid
   * registry; outbox fallback). Runs detached — the scenario does NOT
   * block; the message arrives as a user-side prompt, exactly like the
   * classic `echo advance` mechanism.
   */
  on(match: string | RegExp, message: string): this {
    const pattern = typeof match === "string" ? match : match.source
    this.ctl(["actor-watch", this.session, pattern, message])
    this.record({ t: "actor_watch", session: this.session, pattern, message, at: 0 })
    return this
  }

  /** Same bridge for the window-closing condition (keybind or Ctrl-D): the
   *  close message is submitted when the WINDOW disappears (the tmux
   *  session deliberately survives window closes in this setup). */
  onClose(message: string): this {
    this.ctl(["actor-watch", this.session, "__never_matches__", "", message, this.winid ?? ""])
    this.record({ t: "actor_watch", session: this.session, pattern: "<window-close>", message, at: 0 })
    this.detached = true
    return this
  }
}

// --- hlwm event-wait ----------------------------------------------------------
// This build delivers only the FIRST hook to a `herbstclient --wait`
// listener (then it goes deaf — verified live), so the pattern is one
// fresh, PATTERN-FILTERED listener per awaited event: non-matching hooks
// are ignored by hlwm itself, and the first matching hook resolves.

export type HlwmEvent =
  | "window_title_changed"
  | "focus_changed"
  | "tag_changed"
  | "tag_flags"
  | "client_urgent"
  | "fullscreen_changed"
  | string // this build also emits others; keep it open

/** Resolve when an event mentioning the target winid fires (or timeout). */
export const expectEventFor = (winid: WinId, event: HlwmEvent, timeoutMs = 60_000): Expectation => ({
  describe: `hlwm event '${event}' for ${winid}`,
  check: async (ctl) => {
    void ctl
    try {
      const { stdout } = await execFileAsync(
        "herbstclient",
        ["--wait", event, winid],
        { timeout: timeoutMs, maxBuffer: 1024 * 1024 },
      )
      return stdout.trim().length > 0
    } catch {
      return false // timeout — the event never fired
    }
  },
})
export type UserStep =
  | { readonly t: "on_notification_click"; readonly title?: string }
  | { readonly t: "on_dismiss"; readonly winid?: WinId; readonly how: "close" | "minimize" }
  | { readonly t: "on_capture"; readonly command: string; readonly pattern: string }

// ---------------------------------------------------------------------------
// Client — a managed window
// ---------------------------------------------------------------------------

interface ClientAttrs {
  readonly winid: string
  readonly tag?: string
  readonly title?: string
  readonly floating?: boolean
  readonly minimized?: boolean
}

export class Client {
  private constructor(
    readonly id: WinId,
    private readonly ctl: Ctl,
    private readonly record: (action: SceneAction) => void,
  ) {}

  static async focused(ctl: Ctl, record: (a: SceneAction) => void): Promise<Client> {
    const raw = await ctl(["attrjson", "clients.focus", ".attributes.winid"])
    const id = winId(String(JSON.parse(raw)))
    return new Client(id, ctl, record)
  }

  static existing(id: WinId, ctl: Ctl, record: (a: SceneAction) => void): Client {
    return new Client(id, ctl, record)
  }

  async attrs(): Promise<ClientAttrs> {
    return JSON.parse(await this.ctl(["attrjson", `clients.${this.id}`, ".attributes | {winid, tag, title, floating, minimized}"]))
  }

  /** Decorated frame rect — what the audience sees. */
  async rect(): Promise<Rect> {
    const raw = await this.ctl(["attrjson", `clients.${this.id}`, ".attributes.decoration_geometry"])
    return parseRect(String(JSON.parse(raw)))
  }

  /** Content rect (client area, no decorations). */
  async contentRect(): Promise<Rect> {
    const raw = await this.ctl(["attrjson", `clients.${this.id}`, ".attributes.content_geometry"])
    return parseRect(String(JSON.parse(raw)))
  }

  async isFloating(): Promise<boolean> {
    return (await this.attrs()).floating === true
  }

  async focus(): Promise<this> {
    await this.ctl(["hlwm", "jumpto", this.id])
    return this
  }

  /** Camera + window: move the window to a tag and follow it there. */
  async moveTo(tag: TagName): Promise<this> {
    const raw = await this.ctl(["attrjson", `clients.${this.id}`, ".attributes.tag"])
    const fromTag = tagName(String(JSON.parse(raw)))
    await this.ctl(["hlwm", "jumpto", this.id])
    await this.ctl(["hlwm", "move", tag])
    await this.ctl(["hlwm", "use", tag])
    this.record({ t: "client_move", winid: this.id, tag, ...(fromTag === tag ? {} : { fromTag }), at: 0 })
    return this
  }

  /** Float the window, optionally placing its decorated frame at `rect`. */
  async float(rect?: Rect): Promise<this> {
    await this.ctl(["hlwm", "silent", "attr", `clients.${this.id}.floating`, "true"])
    if (rect) await this.ctl(["hlwm", "silent", "attr", `clients.${this.id}.floating_geometry`, rectStr(rect)])
    this.record({ t: "client_float", winid: this.id, ...(rect ? { rect } : {}), at: 0 })
    return this
  }

  /** Unfloat back into the tiling layer. */
  async tile(): Promise<this> {
    await this.ctl(["hlwm", "silent", "attr", `clients.${this.id}.floating`, "false"])
    this.record({ t: "client_tile", winid: this.id, at: 0 })
    return this
  }

  async minimize(): Promise<this> {
    await this.ctl(["hlwm", "silent", "attr", `clients.${this.id}.minimized`, "true"])
    this.record({ t: "client_minimize", winid: this.id, at: 0 })
    return this
  }

  /** Dismiss by closing. Permanent — the object is dead afterwards. */
  async close(): Promise<void> {
    await this.focus() // hlwm close acts on the focused client
    await this.ctl(["hlwm", "close"])
    this.record({ t: "client_close", winid: this.id, at: 0 })
  }
}

// ---------------------------------------------------------------------------
// Camera — the audience's view
// ---------------------------------------------------------------------------

export class Camera {
  constructor(
    private readonly ctl: Ctl,
    private readonly record: (action: SceneAction) => void,
    private readonly scene: () => Scene,
  ) {}

  /** Move the view to a tag (creates it if missing). The audience follows.
   *  Returns the owning Scene so the fluent chain continues. */
  async focus(tag: TagName): Promise<Scene> {
    await this.ctl(["hlwm", "silent", "add", tag])
    await this.ctl(["hlwm", "use", tag])
    this.record({ t: "camera_focus", tag, at: 0 })
    return this.scene()
  }

  /** Move the view to the tag holding a window and focus that window.
   *  Records the window's CURRENT tag so the backprop checker can flag
   *  accidental jumps to a previous workspace. */
  async follow(win: Client): Promise<Scene> {
    const raw = await this.ctl(["attrjson", `clients.${win.id}`, ".attributes.tag"])
    const winTag = tagName(String(JSON.parse(raw)))
    await this.ctl(["hlwm", "jumpto", win.id])
    this.record({ t: "camera_follow", winid: win.id, winTag, at: 0 })
    return this.scene()
  }

  /** The tag the monitor currently shows. */
  async current(): Promise<TagName> {
    const raw = await this.ctl(["attrjson", "tags.focus", ".attributes.name"])
    return tagName(String(JSON.parse(raw)))
  }
}

// ---------------------------------------------------------------------------
// Scene — one narrated beat; records every action for replay
// ---------------------------------------------------------------------------

export class Scene {
  private readonly actions: SceneAction[] = []
  private readonly t0: number = Date.now()
  private readonly reportedIssues = new Set<string>()
  readonly camera: Camera
  /** Fluent test-framework surface over the human: expect/await/recover. */
  readonly user: UserOps

  constructor(
    readonly name: string,
    private readonly ctl: Ctl,
  ) {
    this.camera = new Camera(ctl, (a) => this.record(a), () => this)
    this.user = new UserOps({ ctl, record: (a) => this.record(a) })
  }

  private record(action: SceneAction): void {
    this.actions.push(action)
    // Backprop check on every recorded action: surface NEW issues as they
    // appear (development-time guard against jarring screen flashes).
    const issues = BackpropChecker.analyze(this.name, this.actions)
    for (const issue of issues) {
      const key = `${issue.index}:${issue.kind}:${issue.description}`
      if (!this.reportedIssues.has(key)) {
        this.reportedIssues.add(key)
        console.warn(`[backprop] ${this.name}#${issue.index} ${issue.kind}: ${issue.description}`)
      }
    }
  }

  /** Full backprop report for this scene (development aid). */
  issues(): ScenarioIssue[] {
    return BackpropChecker.analyze(this.name, this.actions)
  }

  /** ms offset from scene start — replay pacing. */
  private stamp(): number {
    return Date.now() - this.t0
  }

  /** Narrate one paragraph into the narration window. */
  async narrate(text: string): Promise<this> {
    const at = this.stamp()
    await this.ctl(["say", text])
    this.record({ t: "narrate", text, at })
    return this
  }

  /** Idle for the audience; optionally with a sound cue on replay. */
  async wait(ms: number, sound: Sound = { kind: "none" }): Promise<this> {
    const at = this.stamp()
    const n = Math.max(0, Math.min(ms, 600_000))
    await new Promise((resolve) => setTimeout(resolve, n))
    this.record({ t: "wait", ms: n, at, ...(sound.kind === "none" ? {} : { sound }) })
    return this
  }

  /** Desktop notification to the human (optionally replacing the last one;
   *  rescue arms the click-to-return action via the whisper machinery). */
  async whisper(text: string, opts: { title?: string; urgency?: "low" | "normal" | "critical"; replace?: boolean; rescue?: boolean } = {}): Promise<this> {
    const at = this.stamp()
    const args = ["-a", "opencode", "-u", opts.urgency ?? "normal", "-p"]
    if (opts.replace && lastNotifId !== null) args.push("-r", lastNotifId)
    if (opts.rescue) args.push("-A", "default,RESCUE: go to the OpenCode window", "-t", "30000")
    args.push(opts.title && opts.title.trim() !== "" ? opts.title : "opencode", text)
    try {
      const out = (await execFileAsync("dunstify", args, { timeout: opts.rescue ? 310_000 : 10_000 })).stdout.trim()
      const id = out.split("\n")[0]?.trim()
      if (id !== undefined && /^[0-9]+$/.test(id)) lastNotifId = id
    } catch {
      /* notification channel down — the whisper is recorded but undelivered */
    }
    this.record({ t: "whisper", text, ...(opts.title ? { title: opts.title } : {}), ...(opts.replace ? { replace: true } : {}), ...(opts.rescue ? { rescue: true } : {}), at })
    return this
  }

  /** Spawn a managed floating window (narration or controlled terminal). */
  async spawn(role: "narration" | "command", session?: string): Promise<this> {
    const at = this.stamp()
    const args = ["spawn", role]
    if (session) args.push(session)
    await this.ctl(args)
    this.record({ t: "spawn_window", role, ...(session ? { session } : {}), at })
    return this
  }

  /**
   * Run a command in the managed command window; optionally capture its
   * output against a regex with named groups (resolved at replay time and
   * fed to User callbacks — placeholder until the User layer lands).
   */
  async run(command: string, opts: { session?: string; capture?: CaptureSpec } = {}): Promise<this> {
    const at = this.stamp()
    const args = ["run"]
    if (opts.session) args.push(opts.session)
    args.push(command)
    const output = await this.ctl(args)
    if (opts.capture) {
      const re = new RegExp(opts.capture.pattern)
      const m = output.match(re)
      if (!m) throw new Error(`capture failed: /${opts.capture.pattern}/ did not match output`)
      const groups = m.groups ?? {}
      for (const g of opts.capture.groups) {
        if (!(g in groups)) throw new Error(`capture failed: no group '${g}' in /${opts.capture.pattern}/`)
      }
    }
    this.record({ t: "run", command, ...(opts.session ? { session: opts.session } : {}), ...(opts.capture ? { capture: opts.capture } : {}), at })
    return this
  }

  /** Manage an existing window inside this scene. */
  client(id: WinId): Client {
    return Client.existing(id, this.ctl, (a) => this.record(a))
  }

  /** Freeze the scene for serialization. */
  done(): SceneSpec {
    return { name: this.name, actions: this.actions }
  }
}

// ---------------------------------------------------------------------------
// Scenario — titled collection of scenes; save/load as replayable files
// ---------------------------------------------------------------------------

export class Scenario {
  private readonly scenes: Scene[] = []

  private constructor(
    readonly title: string,
    private readonly ctl: Ctl,
  ) {}

  static titled(title: string, ctl: Ctl): Scenario {
    return new Scenario(title, ctl)
  }

  /** Open a new scene (or resume the last one for continued authoring).
   *  On the FIRST scene, the orchestrator's winid is captured from the
   *  currently focused window — the canonical identity for the whole
   *  scenario (rescue, stranded, close-guard all key off it). */
  scene(name?: string): Scene {
    if (name === undefined && this.scenes.length > 0) return this.scenes[this.scenes.length - 1]
    if (this.scenes.length === 0) {
      void Orchestrator.capture(this.ctl).catch(() => undefined)
    }
    const s = new Scene(name ?? `scene-${this.scenes.length + 1}`, this.ctl)
    this.scenes.push(s)
    return s
  }

  spec(): ScenarioSpec {
    return {
      version: 1,
      title: this.title,
      created: new Date().toISOString(),
      scenes: this.scenes.map((s) => s.done()),
    }
  }

  /** Backprop report across all scenes (development aid, not serialized). */
  issues(): ScenarioIssue[] {
    return this.scenes.flatMap((s) => s.issues())
  }

  /** Save as a replayable script file (.scenario.json). */
  async save(dir: string): Promise<string> {
    const spec = this.spec()
    const safe = spec.title.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "")
    const file = path.join(dir, `${safe}.scenario.json`)
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, JSON.stringify(spec, null, 2) + "\n")
    return file
  }

  static async load(file: string): Promise<ScenarioSpec> {
    const spec: ScenarioSpec = JSON.parse(await readFile(file, "utf8"))
    if (spec.version !== 1) throw new Error(`unsupported scenario version: ${spec.version}`)
    return spec
    // Replay interpretation of a loaded spec arrives with the User layer:
    // each SceneAction maps onto the Scene methods above, paced by `at`.
  }
}
