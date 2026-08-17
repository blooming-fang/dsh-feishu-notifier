import { useEffect, useState } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'

export interface FeishuConfigView {
  enabled: boolean
  webhookConfigured: boolean
}

export interface FeishuController {
  config?: FeishuConfigView
  load: () => Promise<FeishuConfigView>
  update: (patch: { enabled?: boolean; webhook?: string }) => Promise<FeishuConfigView>
  test: () => Promise<string>
}

type Props = PropsRuntime<'settings.section'> & { controller: FeishuController }

type ViewState =
  | { status: 'loading' }
  | { status: 'ready'; config: FeishuConfigView }

export function FeishuSettingsSection({ controller }: Props) {
  const [view, setView] = useState<ViewState>({ status: 'loading' })
  const [webhook, setWebhook] = useState('')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('')

  useEffect(() => {
    let active = true
    void controller.load()
      .then(config => {
        if (active) setView({ status: 'ready', config })
      })
      .catch(error => {
        if (active) setStatus(error instanceof Error ? error.message : String(error))
      })
    return () => { active = false }
  }, [controller])

  const config = view.status === 'ready' ? view.config : { enabled: true, webhookConfigured: false }

  const save = async (patch: { enabled?: boolean; webhook?: string }, message: string) => {
    setBusy(true)
    setStatus('正在保存…')
    try {
      const next = await controller.update(patch)
      setView({ status: 'ready', config: next })
      setStatus(message)
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const saveWebhook = async () => {
    const value = webhook.trim()
    if (value === '') {
      setStatus('请输入 Webhook 地址')
      return
    }
    await save({ webhook: value }, 'Webhook 已保存到 DSH 设置文件')
    setWebhook('')
  }

  const sendTest = async () => {
    setBusy(true)
    setStatus('正在发送测试消息…')
    try {
      setStatus(await controller.test())
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section style={{ maxWidth: 680, display: 'grid', gap: 24 }}>
      <div>
        <h2 style={{ margin: 0, fontSize: 24 }}>飞书通知</h2>
        <p style={{ color: 'var(--dsw-alias-label-secondary)', lineHeight: 1.6 }}>
          当智能体等待你的批准、需要回答问题，或一轮对话结束时，向飞书机器人发送提醒。
        </p>
      </div>
      <div style={{ display: 'grid', gap: 16, padding: 20, border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 16 }}>
        <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
          <span>
            <strong style={{ display: 'block' }}>启用通知</strong>
            <small style={{ color: 'var(--dsw-alias-label-secondary)' }}>关闭后不会发送任何飞书消息。</small>
          </span>
          <input
            aria-label="启用通知"
            type="checkbox"
            checked={config.enabled}
            disabled={busy || view.status === 'loading'}
            onChange={event => { void save({ enabled: event.target.checked }, event.target.checked ? '通知已开启' : '通知已关闭') }}
          />
        </label>
        <label style={{ display: 'grid', gap: 8 }}>
          <span><strong>Webhook 地址</strong></span>
          <input
            aria-label="Webhook 地址"
            type="url"
            value={webhook}
            placeholder={config.webhookConfigured ? '已配置地址；输入新地址以替换' : '请输入飞书机器人 Webhook'}
            disabled={busy || view.status === 'loading'}
            onChange={event => { setWebhook(event.target.value); setStatus('') }}
            style={{ minHeight: 40, padding: '0 12px', borderRadius: 10, border: '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-layer-1)', color: 'inherit' }}
          />
        </label>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
          <Button variant="primary" size="sm" disabled={busy || view.status === 'loading'} onClick={() => { void saveWebhook() }}>保存 Webhook</Button>
          <Button variant="outline" size="sm" disabled={busy || view.status === 'loading' || !config.webhookConfigured} onClick={() => { void sendTest() }}>发送测试消息</Button>
        </div>
        {status !== '' && <p role="status" style={{ margin: 0, color: 'var(--dsw-alias-label-secondary)' }}>{status}</p>}
      </div>
    </section>
  )
}
