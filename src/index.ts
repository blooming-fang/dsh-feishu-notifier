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

function textFor(kind: MessageKind, detail: string): string {
  return kind === 'approval'
    ? `DeepSeek Harness 需要你的操作\n${detail}`
    : `DeepSeek Harness 对话已结束\n${detail}`
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
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

async function sendText(webhook: string, text: string): Promise<void> {
  const response = await fetch(webhook, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ msg_type: 'text', content: { text } }),
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
    await sendText(webhookOf(config.webhook.get()), '这是一条来自 DeepSeek Harness 的飞书通知测试消息。')
    writeJson(res, 200, { ok: true, message: '测试消息已发送' })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    writeJson(res, 502, { ok: false, message })
  }
}

/** Send one notification, reading the live configuration as it fires. */
function notify(config: Config, kind: MessageKind, detail: string): void {
  if (!config.enabled.get()) return
  const webhook = config.webhook.get().trim()
  if (webhook === '') return
  void sendText(webhook, textFor(kind, detail)).catch(error => {
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

  ctx.on('approval/request', (request, next) => {
    notify(config, 'approval', request.reason ?? `工具 ${request.toolName} 正在等待批准。`)
    return next()
  })

  ctx.on('session/event', (session, event) => {
    if (event.type === 'turn/end') {
      // 子代理拥有独立的 session；只通知主会话的轮次结束，避免每个子代理完成时发送飞书消息。
      if (session.header.origin === 'subagent') return
      notify(config, 'turn-end', `第 ${String(event.data.turn)} 轮：${turnReasonText(event.data.reason)}`)
    }
    if (event.type === 'tool/call'
      && (event.data.name === 'ask_user_question' || event.data.name === 'exit_plan_mode')) {
      notify(config, 'approval', event.data.name === 'exit_plan_mode'
        ? '智能体正在等待你确认计划。'
        : '智能体正在等待你回答问题。')
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
