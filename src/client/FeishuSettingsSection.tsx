import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { Button, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  ConfigForm,
  ConfigFormSnapshot,
  SettingsDescribeFace,
  SettingsMirrorSnapshot,
} from '@deepseek-ai/dsh-client-ui-settings/client'

/** The `feishu-notifier` section as the settings service serves it; the webhook is redacted. */
export interface FeishuSection {
  enabled?: boolean
  webhook?: string
}

/** Everything the section reads from the plugin's client half. */
export interface FeishuController {
  /** Settings namespace this section edits. */
  namespace: string
  /** Live values and writes of that namespace. */
  form: ConfigForm<FeishuSection>
  /** Shared settings mirror, read for the write-only webhook's configured state. */
  mirror: SettingsDescribeFace
  /** Ask the Host to post one test message through the saved webhook. */
  test: () => Promise<string>
}

type Props = PropsRuntime<'settings.section'> & { controller: FeishuController }

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Read one namespace's write-only secret slots out of the shared mirror. The
 * webhook never rides a settings response, so its configured state comes from
 * the redaction sidecar rather than from the section value.
 */
function secretConfigured(mirror: SettingsMirrorSnapshot, namespace: string, field: string): boolean {
  const view = mirror.view?.namespaces.find(entry => entry.ns === namespace)
  return view?.secrets.some(secret => secret.path.length === 1 && secret.path[0] === field && secret.set) ?? false
}

export function FeishuSettingsSection({ controller }: Props) {
  const snapshot: ConfigFormSnapshot<FeishuSection> = useSyncExternalStore(
    useCallback(listener => controller.form.subscribe(listener), [controller]),
    useCallback(() => controller.form.getSnapshot(), [controller]),
  )
  const mirror: SettingsMirrorSnapshot = useSyncExternalStore(
    useCallback(listener => controller.mirror.subscribe(listener), [controller]),
    useCallback(() => controller.mirror.getSnapshot(), [controller]),
  )
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('')

  useEffect(() => { void controller.mirror.ensure() }, [controller])

  const writable = snapshot.status === 'ready' && snapshot.writable
  const enabled = snapshot.value?.enabled ?? true
  const webhookConfigured = secretConfigured(mirror, controller.namespace, 'webhook')
  const disabled = !writable || busy

  const saveEnabled = async (next: boolean) => {
    setBusy(true)
    setStatus('正在保存…')
    try {
      const accepted = await controller.form.set('enabled', next)
      setStatus(accepted ? (next ? '通知已开启' : '通知已关闭') : '设置未保存，请重试')
    } catch (error) {
      setStatus(messageOf(error))
    } finally {
      setBusy(false)
    }
  }

  const saveWebhook = async () => {
    const value = draft.trim()
    if (value === '') {
      setStatus('请输入 Webhook 地址')
      return
    }
    setBusy(true)
    setStatus('正在保存…')
    try {
      const accepted = await controller.form.set('webhook', value)
      if (accepted) {
        setDraft('')
        setStatus('Webhook 已保存到 DSH 设置文件')
      } else {
        setStatus('Webhook 未被接受，请确认地址是可用的 HTTPS 链接')
      }
    } catch (error) {
      setStatus(messageOf(error))
    } finally {
      setBusy(false)
    }
  }

  const sendTest = async () => {
    setBusy(true)
    setStatus('正在发送测试消息…')
    try {
      setStatus(await controller.test())
    } catch (error) {
      setStatus(messageOf(error))
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
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
          <span>
            <strong style={{ display: 'block' }}>启用通知</strong>
            <small style={{ color: 'var(--dsw-alias-label-secondary)' }}>关闭后不会发送任何飞书消息。</small>
          </span>
          <Switch
            checked={enabled}
            disabled={disabled}
            label="启用通知"
            onChange={next => { void saveEnabled(next) }}
          />
        </div>
        <label style={{ display: 'grid', gap: 8 }}>
          <span><strong>Webhook 地址</strong></span>
          <input
            aria-label="Webhook 地址"
            type="url"
            value={draft}
            placeholder={webhookConfigured ? '已配置地址；输入新地址以替换' : '请输入飞书机器人 Webhook'}
            disabled={disabled}
            onChange={event => { setDraft(event.target.value); setStatus('') }}
            style={{ minHeight: 40, padding: '0 12px', borderRadius: 10, border: '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-layer-1)', color: 'inherit' }}
          />
          {webhookConfigured && (
            <small style={{ color: 'var(--dsw-alias-label-secondary)' }}>
              已保存的 Webhook 不会回显；留空即保持现有地址。
            </small>
          )}
        </label>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
          <Button variant="primary" size="sm" disabled={disabled} onClick={() => { void saveWebhook() }}>保存 Webhook</Button>
          <Button variant="outline" size="sm" disabled={disabled || !webhookConfigured} onClick={() => { void sendTest() }}>发送测试消息</Button>
        </div>
        {!writable && snapshot.status !== 'loading' && (
          <p style={{ margin: 0, color: 'var(--dsw-alias-label-secondary)' }}>
            当前部署的设置为只读，无法在此修改。
          </p>
        )}
        {status !== '' && <p role="status" style={{ margin: 0, color: 'var(--dsw-alias-label-secondary)' }}>{status}</p>}
      </div>
    </section>
  )
}
