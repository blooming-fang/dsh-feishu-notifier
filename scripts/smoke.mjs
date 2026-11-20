import { readFileSync, statSync } from 'node:fs'
import { resolve as resolvePath } from 'node:path'
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

// ------------------------------------------------------------ plugin metadata
// DSH's plugin manager shows each plugin's icon and language-picked title and
// description, read by dsh-app-boot without evaluating plugin code: the icon
// from package.json `icon` (a relative path inside the package, or an exported
// `<specifier>/icon`), the text from `<specifier>/locale/<language>.json` under
// `meta`. Both ride the package `exports` map and the npm `files` whitelist, so
// a missing export or files entry silently degrades the GUI to the bare name.
const ICON_TYPES = ['.svg', '.png', '.jpg', '.jpeg', '.webp']
const MAX_ICON_BYTES = 256 * 1024
const root = new URL('../', import.meta.url)
const readMeta = (language) => {
  const file = new URL(`locale/${language}.json`, root)
  const meta = JSON.parse(readFileSync(file, 'utf8')).meta
  const filled = (value) => typeof value === 'string' && value.trim() !== ''
  return { path: file, ok: filled(meta?.title) && filled(meta?.description) }
}

check('manifest declares an icon path', typeof manifest.icon === 'string' && manifest.icon.startsWith('./'))
const iconFile = new URL(manifest.icon ?? './missing', root)
const iconExt = ICON_TYPES.find((ext) => iconFile.pathname.toLowerCase().endsWith(ext))
check('icon is an SVG/PNG/JPEG/WebP inside the package', iconExt !== undefined
  && iconFile.pathname.startsWith(new URL('.', root).pathname))
check('icon stays inside the size limit dsh-app-boot enforces',
  statSync(iconFile).size > 0 && statSync(iconFile).size <= MAX_ICON_BYTES)
check('exports resolve the locale dictionaries app-boot reads',
  Object.hasOwn(manifest.exports ?? {}, './locale/*.json'))
check('npm files whitelist ships the icon and the locale dictionaries',
  manifest.files.includes('icon.svg') && manifest.files.includes('locale/*.json'))

for (const language of ['en', 'zh']) {
  const meta = readMeta(language)
  check(`locale/${language}.json carries meta.title and meta.description`, meta.ok)
}
// English is the resolver's final fallback, so the two dictionaries must differ.
check('zh and en display text are distinct',
  readFileSync(new URL('locale/zh.json', root), 'utf8') !== readFileSync(new URL('locale/en.json', root), 'utf8'))

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
// Long output is paginated, not truncated: each card stays inside the body
// budget, cuts fall on line boundaries, and the cards together carry the whole
// answer in order.
const longLines = Array.from({ length: 400 }, (_, index) => `第 ${index + 1} 行：${'内容'.repeat(10)}`)
const longText = longLines.join('\n')
const longParts = host.splitOutput(longText)
check('long output splits into several card-sized parts', longParts.length >= 2)
check('every part stays within the per-card ceiling', longParts.every(part => part.length <= 3000))
check('the parts together carry the whole answer', longParts.join('\n') === longText)
check('cuts fall on line boundaries', longParts.slice(1).every(part => longLines.includes(part.split('\n')[0])))

const oneLine = 'x'.repeat(8000)
const oneLineParts = host.splitOutput(oneLine)
check('a single over-long line is cut without losing text',
  oneLineParts.join('') === oneLine && oneLineParts.every(part => part.length <= 3000))

const emojiText = `a${'😀'.repeat(4000)}`
const emojiParts = host.splitOutput(emojiText)
check('a cut never splits a surrogate pair',
  emojiParts.join('') === emojiText && emojiParts.every(part => part.length <= 3000))

const fencedText = `开头\n\`\`\`js\n${'const value = 1\n'.repeat(400)}\`\`\`\n结尾`
const fencedParts = host.splitOutput(fencedText)
const fenceLines = (part) => (part.match(/^`{3,}/gm) ?? []).length
check('a fenced code block is closed and reopened across the cut',
  fencedParts.length >= 2
  && fencedParts.every(part => fenceLines(part) % 2 === 0)
  && fencedParts[1].startsWith('```js'))
check('fence handling keeps the whole fenced content',
  fencedParts.join('\n').includes('const value = 1') && fencedParts.join('\n').includes('结尾'))

// Feishu accepts only image_keys from its upload API in card Markdown; a local
// path or plain URL makes it reject the entire card, so those images are
// rewritten as text before the card is built.
check('a local-path image becomes plain text with its address',
  host.degradeImages('看图 ![预览](.tmp/a.png) 结束') === '看图 [图片：预览]（`.tmp/a.png`） 结束')
check('a relative image address resolves against the session directory',
  host.degradeImages('![预览](.tmp/a.png)', 'J:/work') === `[图片：预览]（\`${resolvePath('J:/work', '.tmp/a.png')}\`）`)
check('an absolute image address is kept as written',
  host.degradeImages('![预览](E:/shots/a.png)', 'J:/work') === '[图片：预览]（`E:/shots/a.png`）')
check('an image without alt text becomes [图片] with its address',
  host.degradeImages('![](x.png)') === '[图片]（`x.png`）')
check('a remote image URL is degraded to text with the URL',
  host.degradeImages('![预览](https://example.com/a.png)') === '[图片：预览]（https://example.com/a.png）')
check('an uploaded Feishu image key is kept',
  host.degradeImages('![预览](img_v3_0238_abc-def)') === '![预览](img_v3_0238_abc-def)')
check('reference-style images degrade',
  host.degradeImages('![预览][ref]') === '[图片：预览]')
check('image syntax inside a fenced code block is left alone',
  host.degradeImages('```md\n![x](y.png)\n```') === '```md\n![x](y.png)\n```')
check('image syntax inside inline code is left alone',
  host.degradeImages('`![x](y.png)`') === '`![x](y.png)`')
check('the hosted card body no longer carries a raw image',
  host.notificationCard('turn-end', 'd', '![预览](.tmp/a.png)').card.body.elements[0].content
  === 'd\n\n[图片：预览]（`.tmp/a.png`）')

check('a card with nothing to say falls back to its title',
  host.notificationCard('turn-end', '', '').card.body.elements[0].content === 'DSH 对话已结束')
check('a named card puts the session in the title',
  host.notificationCard('turn-end', 'd', '', '修复登录接口').card.header.title.content
  === 'DSH 对话已结束 · 修复登录接口')
check('an unnamed card keeps the plain title',
  host.notificationCard('turn-end', 'd', '', '').card.header.title.content === 'DSH 对话已结束')
check('the session name never adds a second header line',
  host.notificationCard('turn-end', 'd', '', '修复登录接口').card.header.subtitle === undefined)

check('assistantText joins text blocks in order',
  host.assistantText({ content: [{ type: 'text', text: 'a' }, { type: 'tool-call' }, { type: 'text', text: 'b' }] }) === 'a\nb')
check('assistantText drops reasoning blocks',
  host.assistantText({ content: [{ type: 'reasoning', text: '思路' }, { type: 'text', text: '答案' }] }) === '答案')
check('assistantText tolerates malformed messages',
  host.assistantText(undefined) === '' && host.assistantText({ content: 'nope' }) === '')

function stubHostCtx(options = {}) {
  const state = { configured: undefined, routes: [], listeners: {} }
  return {
    state,
    fiber: { stub: true },
    effect: (fn) => { fn(); return () => {} },
    on: (event, handler) => { state.listeners[event] = handler },
    // Optional service lookup: the notifier reads the session-title service this
    // way so profiles without it still load the plugin.
    get: (service) => (service === 'sessionTitle' ? options.titles : undefined),
    settings: { configure: (policy, owner) => { state.configured = { policy, owner }; return () => {} } },
    webServer: { register: (route) => { state.routes.push(route); return () => {} } },
  }
}

const sent = []
globalThis.fetch = async (url, init) => {
  sent.push({ url, body: JSON.parse(init.body) })
  return { ok: true, status: 200, text: async () => '{"code":0}' }
}

const main = { header: { id: 'session-main' } }
const subagent = { header: { id: 'session-sub', origin: 'subagent' } }
// Stand-in for @deepseek-ai/dsh-session-title: titles exist only for the main
// session here, so subagent and unknown sessions exercise the no-name path.
const titles = { get: (session) => (session === main ? { title: '修复登录接口' } : undefined) }
const ctx = stubHostCtx({ titles })
const config = host.Config({ enabled: true, webhook: 'https://open.feishu.cn/open-apis/bot/v2/hook/stub' })
host.apply(ctx, config)

check('apply configures settings page policy auto:false', ctx.state.configured?.policy?.auto === false)
check('apply binds the policy to this fiber', ctx.state.configured?.owner === ctx.fiber)
check('apply registers the exact test route', ctx.state.routes.length === 1
  && ctx.state.routes[0].kind === 'exact' && ctx.state.routes[0].path === '/api/feishu-notifier/test')
check('apply registers approval/request', typeof ctx.state.listeners['approval/request'] === 'function')
check('apply registers session/event', typeof ctx.state.listeners['session/event'] === 'function')

const emit = ctx.state.listeners['session/event']
const cardTextOf = (message) => (message.body.card.body.elements ?? []).map(e => e.content ?? '').join('\n')
const titleOf = (message) => message.body.card.header.title.content

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
check('turn/end card title names its session',
  titleOf(sent[0]) === 'DSH 对话已结束 · 修复登录接口')
check('session name rides the card title, not the body',
  cardTextOf(sent[0]).includes('修复登录接口') === false)

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
check('every main-session card keeps naming the session',
  titleOf(sent[2]) === 'DSH 对话已结束 · 修复登录接口')

emit(main, { type: 'tool/call', data: { name: 'ask_user_question' } })
await tick()
check('ask_user_question notifies', sent.length === 4 && cardTextOf(sent[3]).includes('回答问题'))
check('decision-request card names its session',
  titleOf(sent[3]) === 'DSH 需要你的操作 · 修复登录接口')

emit(main, { type: 'tool/call', data: { name: 'exit_plan_mode' } })
await tick()
check('exit_plan_mode notifies', sent.length === 5 && cardTextOf(sent[4]).includes('确认计划'))

emit(main, { type: 'tool/call', data: { name: 'read' } })
await tick()
check('unrelated tool/call is ignored', sent.length === 5)

const outcome = await ctx.state.listeners['approval/request']({ toolName: 'pwsh', agent: { session: main } }, async () => 'allowed-once')
await tick()
check('approval waterfall still delegates to next()', outcome === 'allowed-once')
check('approval/request notifies with tool name', sent.length === 6 && cardTextOf(sent[5]).includes('pwsh'))
check('approval/request reads the name from the requesting agent session',
  titleOf(sent[5]) === 'DSH 需要你的操作 · 修复登录接口')

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
  && sent[beforeRoute].body.card.body.elements[0].content.includes('测试消息')
  && sent[beforeRoute].body.card.header.title.content === 'DSH 飞书通知测试')
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

// A profile that mounts no session-title service must still load and notify —
// the name is an enhancement, never a precondition.
const untitledCtx = stubHostCtx()
host.apply(untitledCtx, host.Config({ enabled: true, webhook: 'https://open.feishu.cn/open-apis/bot/v2/hook/stub' }))
untitledCtx.state.listeners['session/event']({ header: { id: 'session-untitled' } }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
await tick()
check('a deployment without the title service still notifies, just anonymously',
  sent.length === afterRoute + 1 && titleOf(sent.at(-1)) === 'DSH 对话已结束')

// A title service that throws on an alien session must not lose the push.
const brokenTitlesCtx = stubHostCtx({ titles: { get: () => { throw new Error('no such session') } } })
host.apply(brokenTitlesCtx, host.Config({ enabled: true, webhook: 'https://open.feishu.cn/open-apis/bot/v2/hook/stub' }))
brokenTitlesCtx.state.listeners['session/event']({ header: { id: 'session-broken' } }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
await tick()
check('a failing title read degrades to an unnamed card instead of dropping the push',
  sent.length === afterRoute + 2 && titleOf(sent.at(-1)) === 'DSH 对话已结束')

// The card pace follows Feishu's limits: 300 ms between cards while a batch
// stays inside the minute budget, and a slower pace above it so a long batch
// never reaches 100 messages/minute.
check('a short batch is paced at 300 ms per card',
  host.sendIntervalFor(1) === 300 && host.sendIntervalFor(90) === 300)
check('a long batch is slowed below 100 messages/minute',
  host.sendIntervalFor(91) === 670 && host.sendIntervalFor(500) === 670)

// Pagination end-to-end: one long turn-end sends consecutive cards, each
// numbered, spaced by that interval, and together they reproduce the answer.
const paginatedCtx = stubHostCtx({ titles })
host.apply(paginatedCtx, host.Config({ enabled: true, webhook: 'https://open.feishu.cn/open-apis/bot/v2/hook/stub' }))
const beforePaginate = sent.length
const longAnswer = Array.from({ length: 300 }, (_, index) => `第 ${index + 1} 行：${'答案'.repeat(20)}`).join('\n')
const expectedParts = host.splitOutput(longAnswer)
const startedAt = Date.now()
paginatedCtx.state.listeners['session/event'](main, {
  type: 'assistant/message',
  data: { turn: 9, step: 1, message: { content: [{ type: 'text', text: longAnswer }] } },
})
paginatedCtx.state.listeners['session/event'](main, { type: 'turn/end', data: { turn: 9, reason: { kind: 'completed' } } })
let waited = 0
while (sent.length - beforePaginate < expectedParts.length && waited < 10000) {
  await new Promise(resolve => setTimeout(resolve, 10))
  waited += 10
}
const elapsed = Date.now() - startedAt
const paginatedCards = sent.slice(beforePaginate)
check('one long turn-end becomes several consecutive cards',
  paginatedCards.length === expectedParts.length && expectedParts.length >= 2)
check('cards are spaced by the paced interval',
  elapsed >= (expectedParts.length - 1) * 300 - 50)
check('each card title is numbered and keeps the session name',
  paginatedCards.every((card, index) =>
    titleOf(card) === `DSH 对话已结束（${index + 1}/${expectedParts.length}） · 修复登录接口`))
const rejoined = paginatedCards
  .map((card, index) => cardTextOf(card).replace(index === 0 ? '第 9 轮：正常完成\n\n' : '', ''))
  .join('\n')
check('the cards together carry the whole answer once', rejoined === longAnswer)

// A real turn whose answer shows a local screenshot must still be delivered:
// the image is degraded, not left in the card for Feishu to reject.
const imageCtx = stubHostCtx({ titles })
host.apply(imageCtx, host.Config({ enabled: true, webhook: 'https://open.feishu.cn/open-apis/bot/v2/hook/stub' }))
const beforeImage = sent.length
imageCtx.state.listeners['session/event'](main, {
  type: 'assistant/message',
  data: { turn: 10, step: 1, message: { content: [{ type: 'text', text: '看渲染：![预览](.tmp/preview.png) 已完成。' }] } },
})
imageCtx.state.listeners['session/event'](main, { type: 'turn/end', data: { turn: 10, reason: { kind: 'completed' } } })
await tick()
check('a turn-end answer with a local image is still delivered', sent.length === beforeImage + 1)
const imageCardText = cardTextOf(sent.at(-1))
check('the delivered card carries plain text instead of the image',
  imageCardText.includes('[图片：预览]') && imageCardText.includes('![') === false)

// The address comes from the session's working directory, so a relative path
// in the answer becomes a location the reader can actually open.
const cwdCtx = stubHostCtx({ titles })
host.apply(cwdCtx, host.Config({ enabled: true, webhook: 'https://open.feishu.cn/open-apis/bot/v2/hook/stub' }))
const beforeCwd = sent.length
const cwdSession = { header: { id: 'session-cwd', cwd: 'J:/work' } }
cwdCtx.state.listeners['session/event'](cwdSession, {
  type: 'assistant/message',
  data: { turn: 11, step: 1, message: { content: [{ type: 'text', text: '看图 ![预览](.tmp/a.png)' }] } },
})
cwdCtx.state.listeners['session/event'](cwdSession, { type: 'turn/end', data: { turn: 11, reason: { kind: 'completed' } } })
await tick()
check('a delivered card resolves the image address against the session cwd',
  sent.length === beforeCwd + 1
  && cardTextOf(sent.at(-1)).includes(resolvePath('J:/work', '.tmp/a.png')))

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