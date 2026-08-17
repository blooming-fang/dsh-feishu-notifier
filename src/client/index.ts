import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { FeishuSettingsSection, type FeishuController } from './FeishuSettingsSection.tsx'

export const inject = ['slots']

export function apply(ctx: ClientContext): void {
  const controller: FeishuController = {
    load: async () => {
      const response = await fetch('/api/feishu-notifier/config')
      const result = await response.json() as { ok?: boolean; message?: string; config?: FeishuController['config'] }
      if (!response.ok || result.ok !== true || result.config === undefined) {
        throw new Error(result.message ?? `HTTP ${String(response.status)}`)
      }
      return result.config
    },
    update: async (patch) => {
      const response = await fetch('/api/feishu-notifier/config', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      })
      const result = await response.json() as { ok?: boolean; message?: string; config?: FeishuController['config'] }
      if (!response.ok || result.ok !== true || result.config === undefined) {
        throw new Error(result.message ?? `HTTP ${String(response.status)}`)
      }
      return result.config
    },
    test: async () => {
      const response = await fetch('/api/feishu-notifier/test', { method: 'POST' })
      const result = await response.json() as { ok?: boolean; message?: string }
      if (!response.ok || result.ok !== true) throw new Error(result.message ?? `HTTP ${String(response.status)}`)
      return result.message ?? '测试消息已发送'
    },
  }

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'feishu-notifier',
    order: 25,
    label: () => '飞书通知',
    inject: (): { controller: FeishuController } => ({ controller }),
  }, FeishuSettingsSection))
}
