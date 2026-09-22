import { readFileSync } from 'node:fs'

let failures = 0
const check = (label, cond) => {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + label)
  if (!cond) failures++
}
const tick = () => new Promise(resolve => setTimeout(resolve, 0))

// ---------------------------------------------------------------- host half
const host = await import('../lib/index.js')
check('host exports name', host.name === 'dsh-feishu-notifier')
check('host injects settings + webServer', JSON.stringify(host.inject) === JSON.stringify(['settings', 'webServer']))
check('host Config is a schema', typeof host.Config === 'function' && typeof host.Config.toJSON === 'function')

const parsed = host.Config({ enabled: true, webhook: 'https://open.feishu.cn/x' })
check('Config yields live Volatile refs', typeof parsed.enabled?.get === 'function' && typeof parsed.webhook?.get === 'function')
check('Config enabled default is true', host.Config({}).enabled.get() === true)
check('Config webhook default is empty', host.Config({}).webhook.get() === '')
check('Config marks webhook secret', JSON.stringify(host.Config.toJSON()).includes('secret'))

// The settings service only serves fields under a volatile ancestor, and the
// browser reads the webhook's configured state from the redaction sidecar.
const { redactSecrets } = await import('@deepseek-ai/dsh-settings')
const schemaRefs = Object.values(host.Config.toJSON().refs)
check('both Config fields are volatile (the settings page can serve them)',
  schemaRefs.filter(node => node.meta?.volatile === true).length === 2)
check('the webhook is a declared secret slot',
  schemaRefs.some(node => node.meta?.volatile === true && node.meta?.role === 'secret'))
const setView = redactSecrets(host.Config, { enabled: true, webhook: 'https://open.feishu.cn/hook/x' })
check('redaction hides the webhook value', setView.value.webhook === undefined && setView.value.enabled === true)
check('redaction reports the webhook as configured',
  setView.secrets.length === 1 && setView.secrets[0].path[0] === 'webhook' && setView.secrets[0].set === true)
check('redaction reports an unconfigured webhook',
  redactSecrets(host.Config, { enabled: false }).secrets[0].set === false)

check('turnReasonText completed', host.turnReasonText({ kind: 'completed' }) === '正常完成')
check('turnReasonText blocked', host.turnReasonText({ kind: 'blocked' }) === '被策略阻止')
check('turnReasonText max-tokens', host.turnReasonText({ kind: 'max-tokens' }) === '达到最大 token 限制')
check('turnReasonText interrupted', host.turnReasonText({ kind: 'interrupted' }) === '从中断状态恢复时结束')
check('turnReasonText forked', host.turnReasonText({ kind: 'forked' }) === '因分叉而结束')
check('turnReasonText error', host.turnReasonText({ kind: 'error', error: { message: 'boom' } }) === '发生错误：boom')
check('turnReasonText aborted/user', host.turnReasonText({ kind: 'aborted', reason: { kind: 'user' } }) === '已中止：用户取消')
check('turnReasonText aborted/parent', host.turnReasonText({ kind: 'aborted', reason: { kind: 'parent' } }) === '已中止：父代理取消')
check('turnReasonText aborted/hook', host.turnReasonText({ kind: 'aborted', reason: { kind: 'hook', reason: 'sig' } }) === '已中止：sig')
check('turnReasonText aborted/disposed', host.turnReasonText({ kind: 'aborted', reason: { kind: 'disposed' } }) === '已中止：会话已释放')
check('turnReasonText unknown', host.turnReasonText({ kind: 'nope' }) === '结束原因未知')

function stubHostCtx() {
  const state = { configured: undefined, routes: [], listeners: {} }
  return {
    state,
    fiber: { stub: true },
    effect: (fn) => { fn(); return () => {} },
    on: (event, handler) => { state.listeners[event] = handler },
    settings: { configure: (policy, owner) => { state.configured = { policy, owner }; return () => {} } },
    webServer: { register: (route) => { state.routes.push(route); return () => {} } },
  }
}

const sent = []
globalThis.fetch = async (url, init) => {
  sent.push({ url, body: JSON.parse(init.body) })
  return { ok: true, status: 200, text: async () => '{"code":0}' }
}

const ctx = stubHostCtx()
const config = host.Config({ enabled: true, webhook: 'https://open.feishu.cn/open-apis/bot/v2/hook/stub' })
host.apply(ctx, config)

check('apply configures settings page policy auto:false', ctx.state.configured?.policy?.auto === false)
check('apply binds the policy to this fiber', ctx.state.configured?.owner === ctx.fiber)
check('apply registers the exact test route', ctx.state.routes.length === 1
  && ctx.state.routes[0].kind === 'exact' && ctx.state.routes[0].path === '/api/feishu-notifier/test')
check('apply registers approval/request', typeof ctx.state.listeners['approval/request'] === 'function')
check('apply registers session/event', typeof ctx.state.listeners['session/event'] === 'function')

const emit = ctx.state.listeners['session/event']
emit({ header: {} }, { type: 'turn/end', data: { turn: 3, reason: { kind: 'completed' } } })
await tick()
check('main-session turn/end notifies', sent.length === 1 && sent[0].body.content.text.includes('第 3 轮：正常完成'))

emit({ header: { origin: 'subagent' } }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
await tick()
check('subagent turn/end is suppressed', sent.length === 1)

emit({ header: {} }, { type: 'tool/call', data: { name: 'ask_user_question' } })
await tick()
check('ask_user_question notifies', sent.length === 2 && sent[1].body.content.text.includes('回答问题'))

emit({ header: {} }, { type: 'tool/call', data: { name: 'exit_plan_mode' } })
await tick()
check('exit_plan_mode notifies', sent.length === 3 && sent[2].body.content.text.includes('确认计划'))

emit({ header: {} }, { type: 'tool/call', data: { name: 'read' } })
await tick()
check('unrelated tool/call is ignored', sent.length === 3)

const outcome = await ctx.state.listeners['approval/request']({ toolName: 'pwsh' }, async () => 'allowed-once')
await tick()
check('approval waterfall still delegates to next()', outcome === 'allowed-once')
check('approval/request notifies with tool name', sent.length === 4 && sent[3].body.content.text.includes('pwsh'))

// test route
const callRoute = async (method, cfg) => {
  const res = { status: undefined, body: '', writeHead(s) { this.status = s }, end(b) { this.body = b ?? '' } }
  await ctx.state.routes[0].handler({ method }, res)
  return res
}
const okRes = await callRoute('POST')
check('POST test route sends a message', okRes.status === 200 && JSON.parse(okRes.body).ok === true && sent.length === 5)
const getRes = await callRoute('GET')
check('GET test route is 405', getRes.status === 405)

const disabledCtx = stubHostCtx()
host.apply(disabledCtx, host.Config({ enabled: false, webhook: 'https://open.feishu.cn/open-apis/bot/v2/hook/stub' }))
disabledCtx.state.listeners['session/event']({ header: {} }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
await tick()
check('disabled plugin sends nothing', sent.length === 5)
const disabledRes = { status: undefined, body: '', writeHead(s) { this.status = s }, end(b) { this.body = b ?? '' } }
await disabledCtx.state.routes[0].handler({ method: 'POST' }, disabledRes)
check('disabled plugin test route is 409', disabledRes.status === 409)

const emptyCtx = stubHostCtx()
host.apply(emptyCtx, host.Config({ enabled: true, webhook: '' }))
emptyCtx.state.listeners['session/event']({ header: {} }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
await tick()
check('unconfigured webhook sends nothing', sent.length === 5)

// -------------------------------------------------------------- client half
let module
const fakeWindow = { __ModuleLoader__: { load: (m) => { module = m } } }
new Function('window', readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'))(fakeWindow)
check('client bundle loads through __ModuleLoader__', module?.id === 'dsh-feishu-notifier')

const reactStub = { useCallback: (f) => f, useEffect: () => {}, useState: () => [undefined, () => {}], useSyncExternalStore: () => undefined }
const jsxRuntime = { jsx: () => null, jsxs: () => null, Fragment: 'Fragment' }
const primitives = { Button: () => null, Switch: () => null }
const clientExports = module.factory((id) => {
  if (id === 'react') return reactStub
  if (id === 'react/jsx-runtime') return jsxRuntime
  if (id === '@deepseek-ai/dsh-client-ui-primitives') return primitives
  throw new Error('unexpected require: ' + id)
})
check('client injects slots + configForms', JSON.stringify(clientExports.inject) === JSON.stringify(['slots', 'configForms']))

let slot
const clientCtx = {
  slots: { inject: (_name, register) => { slot = register() }, register: (options, Component) => ({ options, Component }) },
  configForms: { get: (ns) => ({ namespace: ns }), describe: () => ({ mirror: true }) },
}
clientExports.apply(clientCtx)
check('client registers settings.section', slot?.options?.name === 'settings.section')
check('client section id is the namespace', slot?.options?.id === 'feishu-notifier')
check('client section order', slot?.options?.order === 25)
check('client section label', slot?.options?.label() === '飞书通知')
const face = slot.options.inject()
check('client injects the controller', face?.controller?.namespace === 'feishu-notifier'
  && typeof face.controller.test === 'function' && typeof face.controller.form === 'object' && typeof face.controller.mirror === 'object')

const testResponse = { ok: true, status: 200, json: async () => ({ ok: true, message: '测试消息已发送' }) }
globalThis.fetch = async () => testResponse
check('client test() posts to the host route', (await face.controller.test()) === '测试消息已发送')

console.log('')
console.log(failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED')
process.exit(failures === 0 ? 0 : 1)