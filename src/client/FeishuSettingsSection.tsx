import { useEffect, useState } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SettingsScope } from '@deepseek-ai/dsh-client-runtime/client'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'

export interface FeishuSettings {
  enabled: boolean
  webhook?: string
}

interface Injected {
  scope: SettingsScope<FeishuSettings>
}

type Props = PropsRuntime<'settings.section'> & Injected

export function FeishuSettingsSection({ scope }: Props) {
  const [snapshot, setSnapshot] = useState(scope.getSnapshot())
  const [webhook, setWebhook] = useState('')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('')

  useEffect(() => scope.subscribe(() => { setSnapshot(scope.getSnapshot()) }), [scope])

  const enabled = snapshot.value?.enabled ?? true
  const saveEnabled = async (value: boolean) => {
    setStatus('正在保存…')
    try {
      await scope.set('enabled', value)
      setStatus(value ? '通知已开启' : '通知已关闭')
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error))
    }
  }

  const saveWebhook = async () => {
    const value = webhook.trim()
    if (value === '') {
      setStatus('请输入 Webhook 地址')
      return
    }
    setBusy(true)
    setStatus('正在保存…')
    try {
      await scope.set('webhook', value)
      setWebhook('')
      setStatus('Webhook 已保存')
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const sendTest = async () => {
    setBusy(true)
    setStatus('正在发送测试消息…')
    try {
      const response = await fetch('/api/feishu-notifier/test', { method: 'POST' })
      const result = await response.json() as { ok?: boolean; message?: string }
      if (!response.ok || result.ok !== true) throw new Error(result.message ?? `HTTP ${String(response.status)}`)
      setStatus(result.message ?? '测试消息已发送')
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
          <input aria-label="启用通知" type="checkbox" checked={enabled} onChange={event => { void saveEnabled(event.target.checked) }} />
        </label>
        <label style={{ display: 'grid', gap: 8 }}>
          <span><strong>Webhook 地址</strong></span>
          <input
            aria-label="Webhook 地址"
            type="url"
            value={webhook}
            placeholder="已保存的地址不会回显；输入新地址以替换"
            onChange={event => { setWebhook(event.target.value); setStatus('') }}
            style={{ minHeight: 40, padding: '0 12px', borderRadius: 10, border: '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-layer-1)', color: 'inherit' }}
          />
        </label>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
          <Button variant="primary" size="sm" disabled={busy || !snapshot.writable} onClick={() => { void saveWebhook() }}>保存 Webhook</Button>
          <Button variant="outline" size="sm" disabled={busy || !snapshot.writable} onClick={() => { void sendTest() }}>发送测试消息</Button>
        </div>
        {status !== '' && <p role="status" style={{ margin: 0, color: 'var(--dsw-alias-label-secondary)' }}>{status}</p>}
        {snapshot.status === 'unavailable' && <p role="alert">当前连接不支持持久化设置。</p>}
      </div>
    </section>
  )
}
