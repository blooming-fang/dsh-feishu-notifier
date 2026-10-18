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
 * Ceiling on the final output carried by one notification. A card body is a
 * push notification, not a transcript: past this length the excerpt is cut and
 * marked, so the message stays inside the webhook's payload budget.
 */
const MAX_OUTPUT_CHARS = 3000

/**
 * Tools whose invocation means the agent is blocked on a human decision, mapped
 * to the line the card carries.
 */
const DECISION_TOOLS = new Map<string, string>([
  ['ask_user_question', '智能体正在等待你回答问题。'],
  ['exit_plan_mode', '智能体正在等待你确认计划。'],
])

/** Card title — the push preview line, so it stays short and reads "DSH". */
function titleFor(kind: MessageKind): string {
  return kind === 'approval' ? 'DSH 需要你的操作' : 'DSH 对话已结束'
}

/** Card header colour, so an approval is visually distinct from a turn end. */
function templateFor(kind: MessageKind): string {
  return kind === 'approval' ? 'orange' : 'blue'
}

/**
 * Card body: the one-line reason, then the agent's final visible output, so the
 * push carries the answer itself instead of only the fact that the turn ended.
 */
function bodyFor(detail: string, output: string): string {
  const text = output.trim()
  if (text === '') return detail
  const excerpt = text.length > MAX_OUTPUT_CHARS
    ? `${text.slice(0, MAX_OUTPUT_CHARS)}\n\n…（输出过长，已截断）`
    : text
  return `${detail}\n\n${excerpt}`
}

/**
 * One interactive-card payload. A custom bot renders Markdown through the
 * card's own `markdown` element (Card JSON 2.0), so the final output keeps its
 * headings, lists, code fences, and links instead of arriving as flat text.
 */
function cardPayload(title: string, template: string, body: string): Record<string, unknown> {
  const text = body.trim()
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
        elements: [{ tag: 'markdown', content: text === '' ? title : text, text_align: 'left' }],
      },
    },
  }
}

/** The card for one notification: kind picks the title and colour, output the excerpt. */
export function notificationCard(kind: MessageKind, detail: string, output: string): Record<string, unknown> {
  return cardPayload(titleFor(kind), templateFor(kind), bodyFor(detail, output))
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

/**
 * 会话标题由 session-title 服务以 `session/title` 事件写进会话日志，这里取最新一条。
 * 桩上下文或尚无标题的会话返回 `undefined`，通知文本退回不带标题的形态。
 */
function sessionTitleOf(session: { snapshotEvents?(): readonly unknown[] }): string | undefined {
  const events = session.snapshotEvents?.() ?? []
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i] as { type?: string; data?: { title?: unknown } }
    if (event.type !== 'session/title') continue
    const title = event.data?.title
    return typeof title === 'string' ? title.trim() : undefined
  }
  return undefined
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

/** Send one notification, reading the live configuration as it fires. */
function notify(config: Config, kind: MessageKind, detail: string, output = ''): void {
  if (!config.enabled.get()) return
  const webhook = config.webhook.get().trim()
  if (webhook === '') return
  void postCard(webhook, notificationCard(kind, detail, output)).catch(error => {
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
    notify(config, 'approval', request.reason ?? `工具 ${request.toolName} 正在等待批准。`)
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
      // 多个会话并行时，轮次号与原因不足以辨认是哪个会话结束，标题补上这一层。
      const title = sessionTitleOf(session)
      const detail = `第 ${String(event.data.turn)} 轮：${turnReasonText(event.data.reason)}`
      notify(config, 'turn-end', title === undefined ? detail : `会话标题：${title}\n${detail}`, output)
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
      if (detail !== undefined) notify(config, 'approval', detail)
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
