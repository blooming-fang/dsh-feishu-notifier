import { readFileSync } from 'node:fs'
import { satisfies } from 'semver'

let failures = 0
const check = (label, cond) => {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + label)
  if (!cond) failures++
}
const tick = () => new Promise(resolve => setTimeout(resolve, 0))

// ------------------------------------------------------- DSH compatibility
// DSH 0.2.0-rc.1 denies a plugin whose package.json declares a
// `@deepseek-ai/dsh` or `@deepseek-ai/dsh-*` peer range that the running
// runtime version does not satisfy (`evaluatePluginCompatibility` in
// dsh-app-boot), so a stale range fails at startup with no code-level symptom.
// Mirror that gate here, against the DSH version this build was compiled for.
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const DSH_RUNTIME = manifest.devDependencies['@deepseek-ai/dsh-settings'].replace(/^[~^]/, '')

check('manifest declares a concrete dsh runtime version to check against',
  /^\d+\.\d+\.\d+/.test(DSH_RUNTIME))

const dshPeers = Object.entries(manifest.peerDependencies ?? {})
  .filter(([name]) => name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-'))
check('manifest declares at least one dsh peer dependency', dshPeers.length > 0)

for (const [name, range] of dshPeers) {
  check(`peer ${name} ${range} admits dsh ${DSH_RUNTIME}`,
    satisfies(DSH_RUNTIME, range, { includePrerelease: true }))
}

// A future DSH release must not be silently admitted by a caret range that
// only reaches the prerelease it was written against, unless that is intended.
const cordisRange = manifest.peerDependencies?.['@deepseek-ai/cordis']
check('cordis peer range is declared', typeof cordisRange === 'string')
check(`cordis peer ${cordisRange} admits the bundled cordis`,
  satisfies(manifest.devDependencies['@deepseek-ai/cordis'].replace(/^[~^]/, ''), cordisRange, { includePrerelease: true }))

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

// A user-initiated stop must not produce a Feishu message; every other outcome
// (including cancellations the user did not request) still notifies.
check('shouldNotifyTurnEnd suppresses a user stop',
  host.shouldNotifyTurnEnd({ kind: 'aborted', reason: { kind: 'user' } }) === false)
check('shouldNotifyTurnEnd keeps a parent cancellation',
  host.shouldNotifyTurnEnd({ kind: 'aborted', reason: { kind: 'parent' } }) === true)
check('shouldNotifyTurnEnd keeps a hook cancellation',
  host.shouldNotifyTurnEnd({ kind: 'aborted', reason: { kind: 'hook', reason: 'sig' } }) === true)
check('shouldNotifyTurnEnd keeps a disposed cancellation',
  host.shouldNotifyTurnEnd({ kind: 'aborted', reason: { kind: 'disposed' } }) === true)
check('shouldNotifyTurnEnd keeps a completed turn',
  host.shouldNotifyTurnEnd({ kind: 'completed' }) === true)
check('shouldNotifyTurnEnd keeps an unknown reason shape',
  host.shouldNotifyTurnEnd(undefined) === true && host.shouldNotifyTurnEnd({}) === true)

// Card construction: notifications ride the Markdown-capable `interactive` type,
// the title reads "DSH", and the body carries the agent's final visible output.
const completedCard = host.notificationCard('turn-end', '第 1 轮：正常完成', '正文 **粗体**')
check('notificationCard builds an interactive card',
  completedCard.msg_type === 'interactive' && completedCard.card.schema === '2.0')
check('turn-end card title uses the short DSH copy',
  completedCard.card.header.title.content === 'DSH 对话已结束')
check('card body renders through the Markdown element',
  completedCard.card.body.elements[0].tag === 'markdown'
  && completedCard.card.body.elements[0].content.includes('第 1 轮：正常完成')
  && completedCard.card.body.elements[0].content.includes('正文 **粗体**'))
check('approval card title uses the short DSH copy',
  host.notificationCard('approval', '工具 pwsh 正在等待批准。', '').card.header.title.content === 'DSH 需要你的操作')
check('no card copy mentions DeepSeek Harness',
  JSON.stringify(completedCard).includes('DeepSeek Harness') === false)
check('over-long output is clipped and marked',
  host.notificationCard('turn-end', 'd', 'x'.repeat(5000)).card.body.elements[0].content.includes('已截断'))
check('a card with nothing to say falls back to its title',
  host.notificationCard('turn-end', '', '').card.body.elements[0].content === 'DSH 对话已结束')

check('assistantText joins text blocks in order',
  host.assistantText({ content: [{ type: 'text', text: 'a' }, { type: 'tool-call' }, { type: 'text', text: 'b' }] }) === 'a\nb')
check('assistantText drops reasoning blocks',
  host.assistantText({ content: [{ type: 'reasoning', text: '思路' }, { type: 'text', text: '答案' }] }) === '答案')
check('assistantText tolerates malformed messages',
  host.assistantText(undefined) === '' && host.assistantText({ content: 'nope' }) === '')

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
const main = { header: { id: 'session-main' } }
const subagent = { header: { id: 'session-sub', origin: 'subagent' } }
const cardTextOf = (message) => (message.body.card.body.elements ?? []).map(e => e.content ?? '').join('\n')

emit(main, { type: 'assistant/message', data: { turn: 3, step: 1, message: { role: 'assistant', content: [
  { type: 'reasoning', text: '这段推理不应出现在通知里' },
  { type: 'text', text: '最终答案：**已完成**。' },
] } } })
emit(main, { type: 'turn/end', data: { turn: 3, reason: { kind: 'completed' } } })
await tick()
check('main-session turn/end notifies', sent.length === 1 && cardTextOf(sent[0]).includes('第 3 轮：正常完成'))
check('turn/end card carries the final assistant output',
  cardTextOf(sent[0]).includes('最终答案：**已完成**。'))
check('turn/end card drops reasoning blocks',
  cardTextOf(sent[0]).includes('这段推理不应出现在通知里') === false)
check('turn/end card title is the short DSH copy',
  sent[0].body.card.header.title.content === 'DSH 对话已结束')

emit(main, { type: 'turn/end', data: { turn: 4, reason: { kind: 'completed' } } })
await tick()
check('final output belongs to the turn that produced it',
  sent.length === 2 && cardTextOf(sent[1]).includes('最终答案') === false)

emit(subagent, { type: 'assistant/message', data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: '子代理输出' }] } } })
emit(subagent, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
await tick()
check('subagent turn/end is suppressed', sent.length === 2)

emit(main, { type: 'assistant/message', data: { turn: 5, step: 1, message: { content: [{ type: 'text', text: '被放弃的输出' }] } } })
emit(main, { type: 'turn/end', data: { turn: 5, reason: { kind: 'aborted', reason: { kind: 'user' } } } })
await tick()
check('user-stopped turn/end stays silent', sent.length === 2)

emit(main, { type: 'turn/end', data: { turn: 6, reason: { kind: 'aborted', reason: { kind: 'parent' } } } })
await tick()
check('parent-cancelled turn/end notifies without inheriting a stopped turn',
  sent.length === 3 && cardTextOf(sent[2]).includes('第 6 轮：已中止：父代理取消')
  && cardTextOf(sent[2]).includes('被放弃的输出') === false)

emit(main, { type: 'tool/call', data: { name: 'ask_user_question' } })
await tick()
check('ask_user_question notifies', sent.length === 4 && cardTextOf(sent[3]).includes('回答问题'))

emit(main, { type: 'tool/call', data: { name: 'exit_plan_mode' } })
await tick()
check('exit_plan_mode notifies', sent.length === 5 && cardTextOf(sent[4]).includes('确认计划'))

emit(main, { type: 'tool/call', data: { name: 'read' } })
await tick()
check('unrelated tool/call is ignored', sent.length === 5)

const outcome = await ctx.state.listeners['approval/request']({ toolName: 'pwsh' }, async () => 'allowed-once')
await tick()
check('approval waterfall still delegates to next()', outcome === 'allowed-once')
check('approval/request notifies with tool name', sent.length === 6 && cardTextOf(sent[5]).includes('pwsh'))

// A PTC session records nested tool calls as tool/ptc-dispatch-start (its top-level
// tool/call is always run_code), so the decision branch must read both event types.
const ptcCall = { rootCallId: 'call_1', parentCallId: 'call_1', subCallId: 'call_1:ptc:1', name: 'ask_user_question', arguments: { questions: [] } }
emit(main, { type: 'tool/ptc-dispatch-start', data: ptcCall })
await tick()
check('PTC-dispatched ask_user_question notifies',
  sent.length === 7 && cardTextOf(sent[6]).includes('回答问题'))

emit(main, { type: 'tool/ptc-dispatch-start', data: { ...ptcCall, subCallId: 'call_1:ptc:2', name: 'exit_plan_mode' } })
await tick()
check('PTC-dispatched exit_plan_mode notifies',
  sent.length === 8 && cardTextOf(sent[7]).includes('确认计划'))

emit(main, { type: 'tool/ptc-dispatch-start', data: { ...ptcCall, subCallId: 'call_1:ptc:3', name: 'pwsh' } })
emit(main, { type: 'tool/ptc-dispatch', data: { ...ptcCall, isError: false, content: [] } })
await tick()
check('ordinary nested tools and PTC completion stay silent', sent.length === 8)

// test route
const callRoute = async (method, cfg) => {
  const res = { status: undefined, body: '', writeHead(s) { this.status = s }, end(b) { this.body = b ?? '' } }
  await ctx.state.routes[0].handler({ method }, res)
  return res
}
const beforeRoute = sent.length
const okRes = await callRoute('POST')
check('POST test route sends a card', okRes.status === 200 && JSON.parse(okRes.body).ok === true
  && sent.length === beforeRoute + 1
  && sent[beforeRoute].body.msg_type === 'interactive'
  && sent[beforeRoute].body.card.schema === '2.0'
  && sent[beforeRoute].body.card.body.elements[0].content.includes('测试消息'))
const getRes = await callRoute('GET')
check('GET test route is 405', getRes.status === 405)
const afterRoute = sent.length

const disabledCtx = stubHostCtx()
host.apply(disabledCtx, host.Config({ enabled: false, webhook: 'https://open.feishu.cn/open-apis/bot/v2/hook/stub' }))
disabledCtx.state.listeners['session/event']({ header: {} }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
await tick()
check('disabled plugin sends nothing', sent.length === afterRoute)
const disabledRes = { status: undefined, body: '', writeHead(s) { this.status = s }, end(b) { this.body = b ?? '' } }
await disabledCtx.state.routes[0].handler({ method: 'POST' }, disabledRes)
check('disabled plugin test route is 409', disabledRes.status === 409)

const emptyCtx = stubHostCtx()
host.apply(emptyCtx, host.Config({ enabled: true, webhook: '' }))
emptyCtx.state.listeners['session/event']({ header: {} }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
await tick()
check('unconfigured webhook sends nothing', sent.length === afterRoute)

// turn/end carries the session title: the latest `session/title` event wins,
// and a session without one keeps the plain text.
const titled = []
globalThis.fetch = async (url, init) => {
  titled.push(JSON.parse(init.body))
  return { ok: true, status: 200, text: async () => '{"code":0}' }
}
const titledCtx = stubHostCtx()
host.apply(titledCtx, host.Config({ enabled: true, webhook: 'https://open.feishu.cn/open-apis/bot/v2/hook/stub' }))
const emitTitled = session => titledCtx.state.listeners['session/event'](
  session,
  { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } },
)
emitTitled({
  header: {},
  snapshotEvents: () => [
    { type: 'session/title', data: { title: '旧标题' } },
    { type: 'session/title', data: { title: '修复登录 bug' } },
  ],
})
await tick()
check('turn/end carries the latest session title',
  titled.length === 1
  && titled[0].card.body.elements[0].content === '会话标题：修复登录 bug\n第 2 轮：正常完成')

emitTitled({ header: {}, snapshotEvents: () => [] })
await tick()
check('turn/end without a session title stays plain',
  titled.length === 2
  && titled[1].card.body.elements[0].content === '第 2 轮：正常完成')

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