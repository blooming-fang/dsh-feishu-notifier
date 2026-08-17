import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-user-approval'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'

export const name = 'dsh-feishu-notifier'

export interface Config {
  enabled: boolean
  webhook: string
}

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  webhook: z.string().role('secret').default(''),
})

const SETTINGS_NAMESPACE = settingsNamespace('feishu-notifier')
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

export function turnReasonText(reason: unknown): string {
  const value = recordOf(reason)
  const kind = typeof value?.kind === 'string' ? value.kind : undefined
  switch (kind) {
    case 'completed': return '正常完成'
    case 'blocked': return '被策略阻止'
    case 'max-tokens': return '达到最大 token 限制'
    case 'interrupted': return '从中断状态恢复时结束'
    case 'error': {
      const error = recordOf(value.error)
      return typeof error?.message === 'string' ? `发生错误：${error.message}` : '发生错误'
    }
    case 'aborted': {
      const cause = recordOf(value.reason)
      if (typeof cause?.reason === 'string') return `已中止：${cause.reason}`
      if (typeof cause?.kind === 'string') return `已中止（${cause.kind}）`
      return '已中止'
    }
    default: return typeof reason === 'string' ? reason : '结束原因未知'
  }
}

async function sendText(current: () => Config, text: string): Promise<void> {
  const config = current()
  const webhook = config.webhook.trim()
  if (!config.enabled || webhook === '') return
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

function writeJson(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(body)
}

async function handleTest(req: IncomingMessage, res: ServerResponse, current: () => Config): Promise<void> {
  if (req.method !== 'POST') {
    res.writeHead(405, { allow: 'POST' })
    res.end()
    return
  }
  try {
    await sendText(current, '这是一条来自 DeepSeek Harness 的飞书通知测试消息。')
    writeJson(res, 200, { ok: true, message: '测试消息已发送' })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    writeJson(res, 502, { ok: false, message })
  }
}

function notify(current: () => Config, kind: MessageKind, detail: string): void {
  void sendText(current, textFor(kind, detail)).catch(error => {
    console.warn(`[feishu-notifier] notification failed: ${String(error)}`)
  })
}

export function apply(ctx: Context, config: Config): void {
  let current: () => Config = () => config
  installSettingsSection(ctx, SETTINGS_NAMESPACE, Config, config, {
    setSource: source => { current = source },
    onChange: () => {},
  })

  ctx.on('approval/request', (request, next) => {
    notify(current, 'approval', request.reason ?? `工具 ${request.toolName} 正在等待批准。`)
    return next()
  })

  ctx.on('session/event', (_session, event) => {
    if (event.type === 'turn/end') {
      notify(current, 'turn-end', `第 ${String(event.data.turn)} 轮：${turnReasonText(event.data.reason)}`)
    }
    if (event.type === 'tool/call'
      && (event.data.name === 'ask_user_question' || event.data.name === 'exit_plan_mode')) {
      notify(current, 'approval', event.data.name === 'exit_plan_mode'
        ? '智能体正在等待你确认计划。'
        : '智能体正在等待你回答问题。')
    }
  })

  ctx.inject(['webServer'], webCtx => {
    webCtx.effect(
      () => webCtx.webServer.register({
        kind: 'exact',
        path: TEST_PATH,
        handler: (req, res) => handleTest(req, res, current),
      }),
      'feishu-notifier: test route',
    )
  })
}
