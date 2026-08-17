import type { ClientContext, SettingsScope } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { FeishuSettingsSection, type FeishuSettings } from './FeishuSettingsSection.tsx'

interface Injected {
  scope: SettingsScope<FeishuSettings>
}

export const inject = ['slots', 'settingsScope']

export function apply(ctx: ClientContext): void {
  const scope = ctx.settingsScope.bind<FeishuSettings>({ namespace: 'feishu-notifier' })
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'feishu-notifier',
    order: 25,
    label: () => '飞书通知',
    inject: (): Injected => ({ scope }),
  }, FeishuSettingsSection))
}
