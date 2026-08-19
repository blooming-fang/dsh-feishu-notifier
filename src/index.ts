import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-user-approval'
import { settingsNamespace, type SettingsScope } from '@deepseek-ai/dsh-settings'

export const name = 'dsh-feishu-notifier'
export const inject = ['settings', 'webServer']

export interface Config {
  enabled: boolean
  webhook: string
}

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  webhook: z.string().role('secret').default(''),
})

const SETTINGS_NAMESPACE = settingsNamespace('feishu-notifier')
const CONFIG_PATH = '/api/feishu-notifier/config'
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

function configView(config: Config): { enabled: boolean; webhookConfigured: boolean } {
  return { enabled: config.enabled, webhookConfigured: config.webhook.trim() !== '' }
}

function writeJson(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(body)
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.from(chunk))
  if (chunks.length === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new Error('请求体不是有效 JSON')
  }
}

function webhookOf(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error('请提供 Webhook 地址')
  const webhook = value.trim()
  const url = new URL(webhook)
  if (url.protocol !== 'https:') throw new Error('Webhook 必须使用 HTTPS 地址')
  return webhook
}

async function sendText(config: Config, text: string): Promise<void> {
  const webhook = webhookOf(config.webhook)
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

async function handleConfig(
  req: IncomingMessage,
  res: ServerResponse,
  scope: SettingsScope<Config>,
): Promise<void> {
  if (req.method === 'GET') {
    writeJson(res, 200, { ok: true, config: configView(scope.get()) })
    return
  }
  if (req.method !== 'POST') {
    res.writeHead(405, { allow: 'GET, POST' })
    res.end()
    return
  }
  try {
    const body = recordOf(await readJson(req))
    if (body === undefined) throw new Error('请求体必须是 JSON 对象')
    const patch: Partial<Config> = {}
    if (body.enabled !== undefined) {
      if (typeof body.enabled !== 'boolean') throw new Error('enabled 必须是布尔值')
      patch.enabled = body.enabled
    }
    if (body.webhook !== undefined) patch.webhook = webhookOf(body.webhook)
    if (Object.keys(patch).length === 0) throw new Error('没有可保存的配置')
    await scope.update(patch)
    writeJson(res, 200, { ok: true, config: configView(scope.get()) })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    writeJson(res, 400, { ok: false, message })
  }
}

async function handleTest(req: IncomingMessage, res: ServerResponse, scope: SettingsScope<Config>): Promise<void> {
  if (req.method !== 'POST') {
    res.writeHead(405, { allow: 'POST' })
    res.end()
    return
  }
  const config = scope.get()
  if (!config.enabled) {
    writeJson(res, 409, { ok: false, message: '飞书通知当前已关闭' })
    return
  }
  try {
    await sendText(config, '这是一条来自 DeepSeek Harness 的飞书通知测试消息。')
    writeJson(res, 200, { ok: true, message: '测试消息已发送' })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    writeJson(res, 502, { ok: false, message })
  }
}

function notify(current: () => Config, kind: MessageKind, detail: string): void {
  const config = current()
  if (!config.enabled || config.webhook.trim() === '') return
  void sendText(config, textFor(kind, detail)).catch(error => {
    console.warn(`[feishu-notifier] notification failed: ${String(error)}`)
  })
}

export function apply(ctx: Context, config: Config): void {
  const scope = ctx.settings.register(SETTINGS_NAMESPACE, Config, { base: config })
  let current = (): Config => scope.get()
  scope.watch(() => { current = () => scope.get() })

  ctx.on('approval/request', (request, next) => {
    notify(current, 'approval', request.reason ?? `工具 ${request.toolName} 正在等待批准。`)
    return next()
  })

  ctx.on('session/event', (session, event) => {
    if (event.type === 'turn/end') {
      // 子代理拥有独立的 session；只通知主会话的轮次结束，避免每个子代理完成时发送飞书消息。
      if (session.header.origin === 'subagent') return
      notify(current, 'turn-end', `第 ${String(event.data.turn)} 轮：${turnReasonText(event.data.reason)}`)
    }
    if (event.type === 'tool/call'
      && (event.data.name === 'ask_user_question' || event.data.name === 'exit_plan_mode')) {
      notify(current, 'approval', event.data.name === 'exit_plan_mode'
        ? '智能体正在等待你确认计划。'
        : '智能体正在等待你回答问题。')
    }
  })

  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: CONFIG_PATH,
      handler: (req, res) => handleConfig(req, res, scope),
    }),
    'feishu-notifier: config route',
  )
  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: TEST_PATH,
      handler: (req, res) => handleTest(req, res, scope),
    }),
    'feishu-notifier: test route',
  )
}
