import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { FeishuSettingsSection, type FeishuController, type FeishuSection } from './FeishuSettingsSection.tsx'

/** Settings namespace of this plugin: the profile entry id its bundle patch inserts. */
const SETTINGS_NAMESPACE = 'feishu-notifier'
const TEST_PATH = '/api/feishu-notifier/test'

export const inject = ['slots', 'configForms']

export function apply(ctx: ClientContext): void {
  const controller: FeishuController = {
    namespace: SETTINGS_NAMESPACE,
    form: ctx.configForms.get<FeishuSection>(SETTINGS_NAMESPACE),
    mirror: ctx.configForms.describe(),
    test: async () => {
      const response = await fetch(TEST_PATH, { method: 'POST' })
      const result = await response.json() as { ok?: boolean; message?: string }
      if (!response.ok || result.ok !== true) throw new Error(result.message ?? `HTTP ${String(response.status)}`)
      return result.message ?? '测试消息已发送'
    },
  }

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: SETTINGS_NAMESPACE,
    order: 25,
    label: () => '飞书通知',
    inject: (): { controller: FeishuController } => ({ controller }),
  }, FeishuSettingsSection))
}
