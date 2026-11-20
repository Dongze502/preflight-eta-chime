# preflight-eta-chime

[![CI](https://github.com/Dongze502/preflight-eta-chime/actions/workflows/ci.yml/badge.svg)](https://github.com/Dongze502/preflight-eta-chime/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![DSH](https://img.shields.io/badge/DSH-0.2.2--rc.3-6f42c1)](https://github.com/Dongze502/preflight-eta-chime#兼容性)
[![Tests](https://img.shields.io/badge/tests-44%20passing-2ea043)](test/index.test.mjs)

> 按需预检 · 实时 ETA · 完成铃声 —— 一个 DeepSeek Harness 的三合一插件。
> 前面 30 多个 ETA 插件都在「执行中」测量；这个插件多问一句：**发送之前，这件事到底要多久？**

三个模块彼此独立、可分别开关，**任何一个模块坏掉都不会阻塞主对话**：

| 模块 | 入口 | 行为 |
| --- | --- | --- |
| ① 发送前预检 | 输入框下方「预检」按钮 / `Ctrl+Shift+Enter` | 起一个只读子代理，判断任务复杂度与耗时区间，结果写进 ETA 先验 |
| ② 执行中 ETA | 输入框下方药丸 | 订阅 `session/event`，把预检先验与实际执行证据融合成实时剩余时间 |
| ③ 完成铃声 | 自动 | 对话正常结束时播放铃声 + 系统通知；同一会话 3 秒内只响一次 |

## 兼容性

| 项 | 值 |
| --- | --- |
| DSH（基线） | `0.2.2-rc.2`，实测 `0.2.2-rc.3` 桌面版 |
| Cordis | `4.1.0` |
| Node.js | `>=24.9.0`（`package.json` 的 `engines.node`） |
| 宿主依赖 | 全部是 `import type`，编译产物零运行时 `@deepseek-ai/*` 依赖 |

DSH 目前是开发者预览版，插件的 Cordis 契约、`session/event` 载荷与客户端插槽都可能随版本变化；升级 DSH 后请先跑 `npm run verify` 再安装。

## 安装

在 DSH 里用插件管理器安装（不要手写 profile 的 `package.json` / `cordis.patch.yml`）：

```
plugin_manager → action: install_bundle → target: <本目录绝对路径>
```

也可以直接从 GitHub 装（DSH CLI）：

```bash
dsh plugin --profile web add github:Dongze502/preflight-eta-chime
```

装到本地开发时，建议先 `npm install && npm run verify`，再 `npm run build`；`lib/` 是构建产物，仓库里不提交。

装好后插件页应显示标题「Preflight ETA Chime」与简介（来自 `locale/zh.json`），图标来自 `assets/icon.svg`。改动源码后需要重新 `npm run build` 并重启 DSH 才能加载新的模块代。

## 三个模块的契约

### 1. 子代理预检（宿主半 `src/preflight.ts`）

按 0.2.2 契约**扁平**传参（早期草稿里的 `request: { parent, prompt }` 嵌套形式在 0.2.2-rc.3 不存在）：

```ts
const activation = await ctx.subagents.startActivation({
  provider: 'spawn',
  label: 'preflight-estimator',
  prompt: [{ type: 'text', text: `${PREFLIGHT_PROMPT}\n\n<conversation>…</conversation>` }],
  parent,                 // 必须是当前会话的 live Agent（agents.get(sessionId) === parent）
  signal,                 // 只取消"发布前"的等待，发布后用 dispose()
  delivery: 'caller',     // 结果直接回到调用方，不污染主对话的完成事件
})
const result = await activation.result
if (result.stopReason !== 'completed') { /* 降级：不解析 output */ }
await activation.dispose()
```

要点：

- `delivery: 'caller'` 而不是 `'parent'`：否则预检子代理的完成事件会混进主对话的完成提醒。
- `stopReason` 是字符串联合 `'completed' | 'aborted' | 'error' | 'max-tokens' | 'refusal'`，**先查它再信 `output`**；不是 `completed` 就返回 `{ ok: false, degraded: true, riskFlags: ['preflight_<reason>'] }`。
- 超时（默认 8s，可在设置里改 1–60s）用 `AbortController` + `Promise.race` 实现，超时后**一定** `dispose()`；`finally` 里统一收尾，任何异常都转成降级结果，**永不 throw**。
- 子代理读取的上下文只取 user/assistant 的文本块（`session.deriveMessages()`），reasoning 与工具输出不进去；**只保留最近 12 条消息、每条最多 1200 字**（两端截断），总量超过 8000 字再保留头 25% + 尾，并在正文里标注省略了多少。这样做是为了避免“对话里出现过一份很大的需求文档”被误当成“本轮要干完的活”。
- prompt 明确写了：`<conversation>` 只是背景，**估算对象只有一条——助手接下来要写的这一条答复**；另外附一行 `<signals>` 具体锚点（本轮用户消息字数、上一条助手答复字数、本会话已完成轮次的平均步数与每步秒数）。
- 子代理必须回一个 `basis` 字段（≤30 字的一句话），说明这个估算依据什么；它会显示在预检卡片与 ETA 浮层里，方便你判断这个数字值不值得信。
- **语言**：prompt 末尾按 `analysisLanguage` 追加一条语言规则（默认中文），`basis` 与 `risk_flags` 都跟着走；这是自由文本，JSON 键名保持不变。
- 答案容错：只给了一侧区间就按 1.7 倍补另一侧；两侧都没给但给了复杂度，就退回该复杂度的默认区间（低 0.4–1.5、中 1.5–4、高 4–12 分钟）；只有连续两次解析失败、超时、`stopReason` 不对或服务缺失才会降级。
- 0.2.2 的 `startActivation` **没有** tools/allow 字段，工具集由 agent preset 组合决定，因此"只读"靠 prompt 约束而不是工具白名单——这是本插件已知的限制，见下文。
- **校准闭环**：每轮真正结束后，宿主把「实际用时 ÷ 当时预测」记进 `$DSH_HOME/preflight-eta-chime/calibration.json`，按「模型声称的复杂度 × 请求字数档位」分桶（`short <400`、`medium <2000`、`long`）。同一桶攒够 3 个样本后，下一次预检会乘上该桶的偏差系数（夹在 0.25–4 倍之间），卡片上写「已按本会话实测修正 ×0.76（12 次样本）」。系数取的是**裁剪后的中位数**：样本满 5 个就先从两端各丢掉一成（至少各一个），这样一次被中断的回合（比值 0.05）或一次挂机的回合（比值 9）不会把整桶带偏。这让插件从"猜"变成"有据的猜"，也解释了为什么它的数字会随使用变准。
- **自己攒样本**：不需要你手动点预检也能学。`turn/start` 时把药丸此刻显示的数字记下来（来源记成 `preflight` / `history` / `coarse`），`turn/end` 时用实测用时除以它，写进对应桶：预检来的进 `<复杂度>|<档位>`，历史节奏来的进 `history|<档位>`，默认区间来的进 `coarse|<档位>`。下次估算时后两类的偏差会分别乘回 `historyBand` / `coarseBand`，所以「从没预检过的请求」也会随使用变准。设置里 `learnFromTurns`（默认开）可整体关掉；设置页会显示「已学习样本：N」。
- **预检缓存**：同一会话、同一条请求文本、同一种分析语言，10 分钟内重复点「预检」直接复用上一次结果（卡片带 `缓存` 标记），不再起子代理、不再花模型调用。改一个字就是新的 key。

### 2. ETA（宿主半 `src/eta.ts`）

从 `ctx.on('session/event', (session, event) => …)` 折叠 `turn/start`、`step/start`、`step/end`、`turn/end`：

- 事件处理器签名是 `(session, event)`；`tool/call` 是**持久事件类型**而不是 Cordis 事件名，所以只监听 `session/event` 即可覆盖它，不要写 `ctx.on('tool/call')`。
- 预检子代理的会话会被跳过：`session.header.origin === 'subagent'`，它们既不计入 ETA 也不触发铃声。
- 融合公式：`weight = clamp(1 - stepsDone/5, 0.2, 1)`；先验先按已用时间折减（`prior_remaining = max(p50 - elapsed, 0.05)`），再与实测节奏融合：`eta = weight × prior_remaining + (1 - weight) × deterministic`。也就是说药丸是**倒计时**，不会在只剩半分钟时还报整轮总时长。
- **兜底链**：预检判断 → 本会话已测得的节奏（`EtaTracker` 记住最近 20 轮的平均步数与每步耗时）→ 粗略默认区间（0.5–2.5 分钟）。`EtaView.source` 会标出数字来自哪一层（`preflight`/`evidence`/`history`/`coarse`），浮层里直接写明“依据：本会话已测得的节奏”之类，不再出现一个没有解释的 `—`；只有你把 ETA 模块关掉时才会是空的。
- 估算范围是**本轮答复**（从用户最后一条消息到这一轮结束），不是整个任务的工期：预检 prompt 明确写了这一点，且允许用小数分钟（`0.5` 表示半分钟）。
- 全部状态在内存里，DSH 重启后清空（预检结果本身也不落盘）。

### 3. 完成提醒（宿主半 `src/server.ts` + 客户端 `client.js`）

- 判定：`event.type === 'turn/end' && event.data.reason.kind === 'completed'`；`aborted` / `error` / `interrupted` 等都不响。
- 去重：同一 sessionId 3 秒内只发一帧；全局同一时刻只播放一个铃声（客户端串行播放）。
- 浏览器侧：系统通知用 `Notification`（权限被拒时只静默，铃声不受影响），铃声用 `<audio>`（内置 ding）或 Web Audio 合成音（success/chime/bell/pop）。
- 音频解锁：浏览器要求用户手势后才能播放，设置页有「解锁音频」按钮，页面任意一次点击也会自动尝试解锁；未解锁时**通知照常弹出、铃声静默**。
- **与其它通知插件共存**：宿主启动时读 profile 的 `dsh.profile.bundles`，若发现 `dsh-pharos`、`dsh-notification`、`dsh-localnotify`、`dsh-voice-alert` 等已知会提醒的插件，且设置里 `chimeRespectNotifiers` 为真（默认），本轮完成帧会带 `silentReason`，客户端不响铃、不再弹一条重复的系统通知——避免两个插件同时响。设置页会列出「同时安装：dsh-pharos」，开关可关掉这条礼让。

## 设置

设置面板有两个入口，指向同一份设置（都由宿主半持久化，改完即时生效）：

1. **插件页**：挂在 `plugins.row.config`，键为 `preflight-eta-chime#preflight-eta-chime`，出现在 **Settings → Plugins → Preflight ETA Chime → 该行右侧的配置按钮**。
2. **ETA 弹层**：点输入框左侧的 `⏱` 药丸 → 浮层右下角「设置」。药丸一定在，所以这个入口不会因为 Host 构建差异而消失。

两条路径渲染的是同一个 `SettingsPanel`，写的是同一份设置。实测（DSH 0.2.2-rc.3、desktop profile）：把 `dsh.client.inject` 收窄成只依赖 `dsh-client-ui-conversation` 之后，插件页的配置按钮也出现了——此前它声明了依赖 `dsh-client-ui-settings-plugins`，而那个外壳依赖的 `dsh-client-ui-settings` 在本 profile 里是 `enabled: false`，注册因此没有落到插件页的 config ledger 里。

字段与默认值：

```json
{
  "preflightEnabled": true,
  "etaEnabled": true,
  "chimeEnabled": true,
  "ringtone": "ding",
  "customRingtoneUrl": null,
  "volume": 0.7,
  "analysisLanguage": "zh",
  "chimeRespectNotifiers": true,
  "learnFromTurns": true,
  "preflightTimeoutMs": 8000
}
```

- `analysisLanguage` 控制预检**自由文本**的语言：`zh`（默认）要求 `basis` 与 `risk_flags` 用简体中文写，`en` 要求英文。JSON 的键名不跟着变——它们是解析契约；变化的只有你读到的句子。改完即时生效，下一次点「预检」就用新语言。
- 宿主自己产生的降级原因（`preflight_timeout`、`preflight_unavailable` 等）是稳定 code，客户端按同一个 `analysisLanguage` 翻译成「预检超时」「预检服务不可用」这类中文，不会把下划线 code 直接甩到界面上；模型自己写的风险项则原样展示。
- `chimeRespectNotifiers`（默认 `true`）控制上面那条礼让：检测到已知通知插件时不响铃。关掉它就永远按 `chimeEnabled` 走，即使同时装着 `dsh-pharos`。
- `learnFromTurns`（默认 `true`）控制「自己攒样本」：关掉后 `turn/end` 不再写校准文件，已有样本仍然生效。
- 校准样本存在 `$DSH_HOME/preflight-eta-chime/calibration.json`（与设置分开，避免被设置页的整份 POST 覆盖）；最多每桶 50 个样本，损坏时回退为"没有样本"。
- 持久化到 `$DSH_HOME/preflight-eta-chime/settings.json`（默认 `~/.dsh/preflight-eta-chime/settings.json`），原子写；文件损坏或只读时退回内存值，不影响会话。
- 自定义铃声支持三种来源：本地上传（wav/mp3/ogg，≤2MB，转 data URL）、HTTPS URL（宿主代理拉取后转 data URL，避免 CORS）、本机绝对路径（如 `D:\sounds\ding.wav`，仅同机有效）。
- 所有字段都会被强制夹取（音量 0–1、超时 1–60s、未知铃声回落到 `ding`），手改文件也弄不坏插件。

## HTTP 端点（宿主半注册在 `webServer`）

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| POST | `/api/preflight/estimate` | `{ sessionId }` → `{ result, eta, signals, calibration }`；缓存命中时 `result.cached === true` |
| GET/POST | `/api/preflight-chime/settings` | 读 / 写设置；读的时候附带 `notifiers`（检测到的通知插件）与 `calibration`（各桶样本） |
| POST | `/api/preflight-chime/ringtone/resolve` | `{ source }` → `{ ok, dataUrl }` |
| GET | `/api/preflight-chime/ringtone/ding.wav` | 内置铃声 |
| GET | `/api/preflight-chime/events?sessionId=` | SSE：`state` / `completed` / `settings` |

安全：`webServer.register` 只写路由表、返回 disposer，所以注册包在 `ctx.effect` 里；请求先过 `ctx.connection.admit(req)`（没有该服务时退回回环 Host + 同源校验），跨站/异源一律 401/403。这些端点是只读上下文 + 本地设置，不会执行任意命令。

## 与其它 ETA 插件的关系

**建议共存，不要二选一。** 注册表里的 ETA 插件都在「执行中」测量，本插件在「发送前」判断，两者回答的不是同一个问题：

| 插件 | 做法 | 与本插件的关系 |
| --- | --- | --- |
| `dsh-session-turn-eta` | 进度条 + 百分比 + 本轮剩余时间，随执行重新基准 | 执行期看它；发送前想知道"值不值得等"看这里。两个一起装不冲突（它注册在 composition 下方，本插件在输入框 dock） |
| `dsh-conv-progress` | 每轮胶囊 + 经验 ETA 表 + 轮次历史 | 它的经验表同样来自实测，但只在执行期起作用；本插件的校准只用于预检先验 |
| `dsh-work-progress` | 任务完成度 + 当前动作 + 逐步耗时 | 信息更全，但同样只在执行中 |
| `dsh-eta-forecast` | 按 todo 完成比例预测 | 不做 todo 解析，避免重复 |
| `dsh-progress-eta` | 让 LLM 精修 ETA 并给权重封顶 | 本插件只做一次**手动、只读**的预检，不持续占用模型；不争默认路径 |

完成提醒只做最小实现（一次铃声 + 一条系统通知）；如果 profile 里已经有 `dsh-pharos` / `dsh-notification` 这类插件，默认礼让静默（见上文设置），不会双响。

## 已知限制

1. **预检子代理没有工具白名单**：0.2.2 的 `SubagentActivationSpec` 不含 tools/allow，工具集继承 agent preset，"只读"只能靠 prompt 约束。
2. **`inject` 不含 `subagents`**（与最初规格的一处刻意偏离）：Cordis 4.1 的 `inject` 没有 optional 形式，把 `subagents` 写进去会让缺少该服务的 profile **整个插件不激活**，连带 ETA 和铃声一起消失，违反"subagents 缺失时只关预检"的验收标准。现在用 `ctx.inject(['subagents'], …)` 局部订阅，服务出现即启用、消失即降级。若你的 profile 一定带 subagents，想恢复硬依赖只需把 `'subagents'` 加进 `src/index.ts` 的 `inject` 数组。
3. **客户端走同源 HTTP/SSE** 而不是 `ctx.remote` 类型化 RPC：本插件自带端点，浏览器侧直接 `fetch`/`EventSource`，少一层宿主 remote 注册；如果将来 DSH 对第三方端点收紧，这里需要改成 remote 命名空间。
4. ETA 只覆盖当前打开的会话；多窗口同时看不同会话时各自一条 SSE，互不影响。
5. Windows 下自定义铃声的绝对路径依赖宿主进程可读该文件。
6. **校准是分桶裁剪中位数，不是学习模型**：每个桶要 3 个样本才生效，且只按「复杂度 × 请求长度」分桶；跨机器、跨模型的偏差不会自动迁移，换模型后建议删掉 `calibration.json` 重新积累。
7. 缓存只认「同会话 + 同请求文本 + 同语言」，修改历史消息或用另一条请求会重新触发子代理。
8. **没有浏览器级 E2E**：宿主没有开 `--remote-debugging-port`，CDP 驱动不了正在跑的桌面窗口；现有一层真 DOM（jsdom + 真 React）能抓渲染与交互回归，但抓不到布局、CSS 变量是否真的解析、暗色主题下的视觉结果，这些仍要靠人工看一眼。
9. 设置面板有两个入口（插件页行内配置、药丸弹层），两者共享同一个 `SettingsPanel`；若某个 Host 构建不声明 `plugins.row.config`，插件页入口不存在，药丸入口仍然可用。

## 开发与测试

```bash
npm install          # 依赖从 npmjs 拉取，peer 全部 optional
npm run build        # tsc -> lib/
npm test             # 42 个宿主验收用例 + 2 个真 DOM 组件用例
npm run smoke        # 用假 window + react stub 渲染药丸/设置表单/预检卡片，抓渲染期崩溃
```

`npm test` 跑两个文件：

- `test/index.test.mjs`（42 个用例，进程内跑；`node --test` 在沙箱里会 spawn EPERM）——宿主契约与纯函数。
- `test/client.dom.test.mjs`（2 个用例，真 jsdom + 真 React 18）——把 `client.js` 挂进 DOM，真的点开药丸、真的点「设置」、真的勾选开关并保存，断言请求体与卡片文本。这一层是为那次 `ReferenceError: notifiers is not defined` 补的：stub 渲染在 settings 为 null 时根本走不到出事的行，导致渲染器已经白屏、测试还是绿的。它同时能抓住 hook 顺序、受控输入、事件绑定这类只有真 React 才暴露的问题。

测试覆盖（`test/index.test.mjs`）：

- 预检 prompt 明确把 `<conversation>` 定性为背景、以“助手接下来这一条答复”为估算对象，且要求必给数字与 `basis`；转写只含 user/assistant 文本、只留最近 12 条；
- `stopReason !== 'completed'` 时降级且**不解析** output；`delivery` 必须是 `caller`；
- 超时路径 `dispose()` 被调用；`subagents` 缺失时降级而不抛；
- 预检 JSON 解析（围栏/散文容错）与无效答案拒绝；
- 先验权重随证据衰减、证据把估计拉向实测节奏；执行中先验按已用时间**倒减**（不会重复报整轮总时长）；
- 兜底链覆盖三种“没预检”的情况：有历史节奏用历史、什么都没有用粗略默认区间，并各自打上 `source` 标记；
- 半截答案（只给 p90、只给 p50、只给复杂度）都能补全成完整区间，`basis` 会截断到 80 字；
- 分析语言默认中文、可切英文，且切换只影响 prompt 里的语言规则；
- 已知降级 code 在客户端被翻译成中文（或英文），未知的模型自由文本原样透传；
- 设置往返与夹取、`exists` 语义；
- `session/event`：`tool/call` 不触发完成、子代理会话不触发完成、同一会话 3 秒内只发一帧、`aborted` 不响；
- 回环/同源校验；
- 客户端信封 id、四个插槽注册（eta / preflight / settings / overlay）与 zh/en 词典注册；
- 设置表单在拿到 settings 之后能真的渲染完（渲染期引用未声明变量会把整个渲染器带崩，这条用例就是为它加的）；
- 药丸与预检卡片不会互相矛盾：空闲时两者都原样显示预检的 p50/p90（不做二次取整），执行中卡片改读同一份实时视图（显示「剩余」并保留「初始预估」一行），结束后显示本轮实测用时；
- 校准：分桶键、中位数、因子夹取（≥3 样本才生效，0.25–4 倍）、样本上限 50、落盘后重读一致；
- 预检结果按实测偏差缩放（4 分钟 × 0.5 = 2 分钟），且同会话同请求第二次点击命中缓存、不再起子代理；
- 一轮结束把 `实际 ÷ 预测` 写进对应桶（`high|short` 拿到 0.05 的下限样本）；
- 通知插件检测：读 profile 的 `dsh.profile.bundles`，能匹配带版本号的 `dsh-pharos@1.2.3`，profile 缺失时安静返回空；
- `chimeRespectNotifiers` 默认 true、可关、非法值回落；
- 没有预检的回合也会留下样本（落到 `coarse|<档位>` 桶），`learnFromTurns: false` 时不写；
- 学到的 band 因子真的会缩小药丸显示的范围（`history` 与 `coarse` 两个桶各自独立）；
- 一个被中断的回合（比值 0.05）拖不偏整桶系数：裁剪后中位数只由中间的样本决定；
- 浮层与对话框的底色/文字色来自 `--dsw-alias-card-fill` / `--dsw-alias-label-primary`，且有断言禁止再写死十六进制颜色（暗色主题下不再是一块白板）。

构建产物 `lib/*.js` 里 `@deepseek-ai/*` 只出现在 `import type` 中（编译后为 0 处），所以插件装进 profile 时不需要宿主包可解析。

## 许可

MIT，见 `LICENSE`。
