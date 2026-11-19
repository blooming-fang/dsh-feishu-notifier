import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context, Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-user-approval'

export const name = 'dsh-feishu-notifier'
export const inject = ['settings', 'webServer']

/**
 * Plugin configuration. Both fields are `volatile`, so the settings service
 * updates them in place rather than remounting the plugin: these references stay
 * valid for the plugin's whole lifetime and `.get()` always answers the value
 * the user last saved. The webhook is `role('secret')`, so it never rides a
 * settings response back to the browser.
 */
export interface Config {
  enabled: Volatile<boolean>
  webhook: Volatile<string>
}

export const Config = z.object({
  enabled: z.boolean().default(true).volatile(),
  webhook: z.string().role('secret').default('').volatile(),
})

const TEST_PATH = '/api/feishu-notifier/test'

type MessageKind = 'approval' | 'turn-end'

/**
 * Ceiling on the Markdown text one card carries. A longer answer is not cut
 * short: the notification continues in further cards of at most this size, so
 * the whole answer arrives while each webhook call stays inside the payload
 * budget.
 */
const MAX_PART_CHARS = 3000

/**
 * Tools whose invocation means the agent is blocked on a human decision, mapped
 * to the line the card carries.
 */
const DECISION_TOOLS = new Map<string, string>([
  ['ask_user_question', '智能体正在等待你回答问题。'],
  ['exit_plan_mode', '智能体正在等待你确认计划。'],
])

/**
 * Card title — the push preview line, so it leads with the short "DSH" phrase
 * and then names the session. Feishu's push preview shows only the card title,
 * never the body, so the session name belongs here rather than in the body: a
 * lock-screen notification then says which conversation needs attention.
 */
function titleFor(
  kind: MessageKind,
  sessionTitle = '',
  part?: { index: number; total: number },
): string {
  const label = kind === 'approval' ? 'DSH 需要你的操作' : 'DSH 对话已结束'
  // A paginated answer marks each card so the push preview shows which piece it
  // is; a single card keeps the plain phrase.
  const sequence = part === undefined || part.total <= 1
    ? label
    : `${label}（${part.index}/${part.total}）`
  const session = sessionTitle.trim()
  return session === '' ? sequence : `${sequence} · ${session}`
}

/** Card header colour, so an approval is visually distinct from a turn end. */
function templateFor(kind: MessageKind): string {
  return kind === 'approval' ? 'orange' : 'blue'
}

/**
 * The slice of the session-title service this plugin reads. It is a structural
 * type because the service is optional here: `@deepseek-ai/dsh-session-title` is
 * a separate bundle, and a profile without it must still load this plugin.
 */
interface SessionTitleReader {
  get(session: unknown): { title: string } | undefined
}

/**
 * The session's display name — the title DSH shows in its session list.
 *
 * Read through `ctx.get` instead of a declared injection so a deployment that
 * mounts no title service still loads this plugin and simply sends cards
 * without the name. A title appears only after the service derives it from the
 * conversation, so early notifications carry none; any read failure degrades to
 * the unnamed card rather than dropping the notification itself.
 */
function sessionTitleOf(ctx: Context, session: unknown): string {
  if (typeof session !== 'object' || session === null) return ''
  const titles = ctx.get('sessionTitle') as SessionTitleReader | undefined
  if (titles === undefined) return ''
  try {
    const title = titles.get(session)?.title
    return typeof title === 'string' ? title.trim() : ''
  } catch {
    return ''
  }
}

/**
 * Card body: the one-line reason, then the agent's final visible output (or
 * its first card-sized part), so the push carries the answer itself instead of
 * only the fact that the turn ended.
 */
function bodyFor(detail: string, output: string): string {
  return output === '' ? detail : `${detail}\n\n${output}`
}

/** An open fenced code block, carried from one card to the next. */
interface FenceState {
  /** The opening fence line, reused to reopen the block in the next card. */
  readonly line: string
  /** The opening marker run (` ``` ` or `~~~`), used to close the block. */
  readonly marker: string
}

const FENCE_LINE = /^\s{0,3}(`{3,}|~{3,})(.*)$/

/**
 * The fenced code block still open at the end of this text, when one is. It
 * lets a card boundary fall inside code without breaking its rendering: the
 * card that ends in the block closes it, and the next card reopens it.
 */
function fenceAfter(text: string): FenceState | undefined {
  let open: FenceState | undefined
  for (const line of text.split('\n')) {
    const match = FENCE_LINE.exec(line)
    if (match === null) continue
    const run = match[1]
    if (open === undefined) {
      open = { line, marker: run }
      continue
    }
    // Only a bare run of the same character closes the block.
    if (run[0] === open.marker[0] && run.length >= open.marker.length && match[2].trim() === '') {
      open = undefined
    }
  }
  return open
}

/** Cut boundary for a line longer than the ceiling, never inside a surrogate pair. */
function safeCut(text: string, max: number): number {
  const code = text.charCodeAt(max - 1)
  return code >= 0xD800 && code <= 0xDBFF ? max - 1 : max
}

/**
 * Split the visible output into card-sized parts.
 *
 * Cuts prefer line boundaries and cut a line only when it alone exceeds the
 * ceiling. A cut that lands inside a fenced code block closes the fence on the
 * card that ends there and reopens it on the next card, so code keeps rendering
 * as code instead of leaking into prose. Parts are consecutive: sending them in
 * order reproduces the answer across the chat.
 */
export function splitOutput(text: string, max = MAX_PART_CHARS): string[] {
  if (text.length <= max) return [text]

  const chunks: string[] = []
  let rest = text
  while (rest.length > max) {
    const lineBreak = rest.lastIndexOf('\n', max)
    if (lineBreak > 0) {
      chunks.push(rest.slice(0, lineBreak))
      rest = rest.slice(lineBreak + 1)
      continue
    }
    const cut = safeCut(rest, max)
    chunks.push(rest.slice(0, cut))
    rest = rest.slice(cut)
  }
  // The final chunk is empty when the cut landed on a trailing newline.
  if (rest !== '') chunks.push(rest)

  const parts: string[] = []
  let fence: FenceState | undefined
  for (const chunk of chunks) {
    const body = fence === undefined ? chunk : `${fence.line}\n${chunk}`
    const open = fenceAfter(body)
    if (open === undefined) {
      parts.push(body)
      fence = undefined
    } else {
      parts.push(`${body}\n${open.marker}`)
      fence = open
    }
  }
  return parts
}

/**
 * One interactive-card payload. A custom bot renders Markdown through the
 * card's own `markdown` element (Card JSON 2.0), so the final output keeps its
 * headings, lists, code fences, and links instead of arriving as flat text.
 *
 * The header carries exactly one title line (the session name is part of it),
 * so the card never reads as two competing headings, and the body keeps
 * carrying only what happened and what the agent said.
 */
function cardPayload(title: string, template: string, body: string): Record<string, unknown> {
  return {
    msg_type: 'interactive',
    card: {
      schema: '2.0',
      config: { update_multi: true },
      header: {
        template,
        title: { tag: 'plain_text', content: title },
      },
      body: {
        direction: 'vertical',
        // Keep the body verbatim: leading spaces and blank lines belong to
        // indented code and fenced blocks carried across cards.
        elements: [{ tag: 'markdown', content: body.trim() === '' ? title : body, text_align: 'left' }],
      },
    },
  }
}

/**
 * The card for one notification: kind picks the title and colour, output the
 * body text, and sessionTitle names the session in the title. This builds a
 * single card; `notify` paginates longer output through `splitOutput`.
 */
export function notificationCard(
  kind: MessageKind,
  detail: string,
  output: string,
  sessionTitle = '',
): Record<string, unknown> {
  return cardPayload(titleFor(kind, sessionTitle), templateFor(kind), bodyFor(detail, output))
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/**
 * Visible text of an assistant message: its `text` blocks joined in order.
 * Reasoning and tool-call blocks are dropped — the notification carries what the
 * human would read in the conversation, not the model's working notes.
 */
export function assistantText(message: unknown): string {
  const content = recordOf(message)?.content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    const part = recordOf(block)
    if (part?.type === 'text' && typeof part.text === 'string') parts.push(part.text)
  }
  return parts.join('\n').trim()
}

/** Readable text for the cancellation cause of an `aborted` turn end. */
function abortCauseText(cause: unknown): string {
  const value = recordOf(cause)
  if (value === undefined) return ''
  switch (value.kind) {
    case 'user': return '：用户取消'
    case 'parent': return '：父代理取消'
    case 'hook': return typeof value.reason === 'string' ? `：${value.reason}` : '：钩子取消'
    case 'disposed': return '：会话已释放'
    default: return ''
  }
}

/**
 * Whether a `turn/end` reason deserves a notification.
 *
 * A user-initiated stop (`aborted` whose cancel cause is `user`) stays silent:
 * whoever pressed stop is already sitting at the harness, so a Feishu push would
 * only be noise. Cancellations the user did not request (parent, hook, disposed)
 * still notify, since they can happen while nobody is watching the UI.
 */
export function shouldNotifyTurnEnd(reason: unknown): boolean {
  const value = recordOf(reason)
  if (value?.kind !== 'aborted') return true
  return recordOf(value.reason)?.kind !== 'user'
}

/** Readable Chinese text for a `turn/end` reason. */
export function turnReasonText(reason: unknown): string {
  const value = recordOf(reason)
  if (value === undefined) return typeof reason === 'string' ? reason : '结束原因未知'
  switch (value.kind) {
    case 'completed': return '正常完成'
    case 'blocked': return '被策略阻止'
    case 'max-tokens': return '达到最大 token 限制'
    case 'interrupted': return '从中断状态恢复时结束'
    case 'forked': return '因分叉而结束'
    case 'error': {
      const error = recordOf(value.error)
      return typeof error?.message === 'string' ? `发生错误：${error.message}` : '发生错误'
    }
    case 'aborted': return `已中止${abortCauseText(value.reason)}`
    default: return '结束原因未知'
  }
}

function writeJson(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(value))
}

/** Validate the saved webhook into the exact address the sender posts to. */
function webhookOf(value: string): string {
  const webhook = value.trim()
  if (webhook === '') throw new Error('请先保存飞书机器人 Webhook 地址')
  const url = new URL(webhook)
  if (url.protocol !== 'https:') throw new Error('Webhook 必须使用 HTTPS 地址')
  return webhook
}

async function postCard(webhook: string, payload: unknown): Promise<void> {
  const response = await fetch(webhook, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    redirect: 'error',
  })
  const body = await response.text()
  if (!response.ok) throw new Error(`Feishu webhook returned HTTP ${String(response.status)}: ${body.slice(0, 200)}`)
  try {
    const result = JSON.parse(body) as { code?: number; msg?: string }
    if (result.code !== undefined && result.code !== 0) {
      throw new Error(`Feishu webhook rejected the message: ${result.msg ?? `code ${String(result.code)}`}`)
    }
  } catch (error) {
    if (error instanceof SyntaxError) return
    throw error
  }
}

async function handleTest(req: IncomingMessage, res: ServerResponse, config: Config): Promise<void> {
  if (req.method !== 'POST') {
    res.writeHead(405, { allow: 'POST' })
    res.end()
    return
  }
  if (!config.enabled.get()) {
    writeJson(res, 409, { ok: false, message: '飞书通知当前已关闭' })
    return
  }
  try {
    await postCard(
      webhookOf(config.webhook.get()),
      cardPayload('DSH 飞书通知测试', 'turquoise', '这是一条来自 DSH 的飞书通知测试消息。'),
    )
    writeJson(res, 200, { ok: true, message: '测试消息已发送' })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    writeJson(res, 502, { ok: false, message })
  }
}

/**
 * Send one notification, reading the live configuration as it fires. Output
 * longer than one card is paginated: the cards go out one after another, in
 * order, so the answer arrives complete across several messages.
 */
function notify(
  config: Config,
  kind: MessageKind,
  detail: string,
  output = '',
  sessionTitle = '',
): void {
  if (!config.enabled.get()) return
  const webhook = config.webhook.get().trim()
  if (webhook === '') return
  const parts = splitOutput(output.trim())
  const total = parts.length
  const send = async (): Promise<void> => {
    for (const [index, part] of parts.entries()) {
      // Only the first card carries the turn line; later cards continue the
      // answer, marked by the part counter in the title.
      const body = index === 0 ? bodyFor(detail, part) : part
      const title = titleFor(kind, sessionTitle, total > 1 ? { index: index + 1, total } : undefined)
      try {
        await postCard(webhook, cardPayload(title, templateFor(kind), body))
      } catch (error) {
        throw new Error(`第 ${String(index + 1)}/${String(total)} 条通知发送失败：${String(error)}`)
      }
    }
  }
  void send().catch(error => {
    console.warn(`[feishu-notifier] notification failed: ${String(error)}`)
  })
}

export function apply(ctx: Context, config: Config): void {
  // This bundle ships its own settings page, so the generic page the settings
  // shell would otherwise generate for the namespace stays off.
  ctx.effect(
    () => ctx.settings.configure({ auto: false }, ctx.fiber),
    'feishu-notifier: settings page policy',
  )

  // Latest visible assistant output per session, consumed by that session's
  // `turn/end` so the card carries the final answer. Keyed by session id because
  // subagent sessions and concurrent conversations interleave in this handler.
  const finalOutput = new Map<string, string>()

  ctx.on('approval/request', (request, next) => {
    notify(
      config,
      'approval',
      request.reason ?? `工具 ${request.toolName} 正在等待批准。`,
      '',
      sessionTitleOf(ctx, request.agent?.session),
    )
    return next()
  })

  ctx.on('session/event', (session, event) => {
    if (event.type === 'assistant/message') {
      // 子代理的输出不进入通知；主会话只保留最近一段非空可见文本作为最终输出。
      if (session.header.origin === 'subagent') return
      const text = assistantText(event.data.message)
      if (text !== '') finalOutput.set(session.header.id, text)
      return
    }
    if (event.type === 'turn/end') {
      const output = finalOutput.get(session.header.id) ?? ''
      // 输出只属于产生它的那一轮：无论是否发送通知，都在这里消费掉。
      finalOutput.delete(session.header.id)
      // 子代理拥有独立的 session；只通知主会话的轮次结束，避免每个子代理完成时发送飞书消息。
      if (session.header.origin === 'subagent') return
      // 用户主动停止的轮次不发送通知：用户就在 DSH 界面旁，无需再收到飞书消息。
      if (!shouldNotifyTurnEnd(event.data.reason)) return
      notify(
        config,
        'turn-end',
        `第 ${String(event.data.turn)} 轮：${turnReasonText(event.data.reason)}`,
        output,
        sessionTitleOf(ctx, session),
      )
    }
    // 等待用户决策的记录有两种形态，必须都认，否则会漏通知：
    //   - 普通会话：顶层 `tool/call`，name 就是被调用的工具；
    //   - PTC（程序化工具调用）会话：顶层只有 `run_code`，嵌套调用走
    //     `tool/ptc-dispatch-start`（该事件在调用真正开始、即提问弹出的那一刻发出；
    //     完成时的 `tool/ptc-dispatch` 已经太晚，不用于通知）。
    const eventType: string = event.type
    if (eventType === 'tool/call' || eventType === 'tool/ptc-dispatch-start') {
      const toolName = recordOf(event.data)?.name
      const detail = typeof toolName === 'string' ? DECISION_TOOLS.get(toolName) : undefined
      if (detail !== undefined) notify(config, 'approval', detail, '', sessionTitleOf(ctx, session))
    }
  })

  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: TEST_PATH,
      handler: (req, res) => handleTest(req, res, config),
    }),
    'feishu-notifier: test route',
  )
}
