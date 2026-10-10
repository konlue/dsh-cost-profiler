# dsh-cost-profiler

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 turn 级成本/性能剖析器 —— 做归因分析，而不只是余额显示。

DSH 插件生态里有几百个"剩余额度"组件，但没有一个能回答：一个会话的 token、时间、费用到底花在了哪里。本插件把会话自身的事件流折叠成按 turn、按模型、按工具的剖析报告，按需渲染 —— **零额外 LLM 调用、零额外存储**。

[English](./README.md)

## 功能

- **`/cost` 斜杠命令** —— 即时会话报告，三档粒度：
  - `/cost` 或 `/cost summary` —— 总量、按模型分解、最慢工具排行
  - `/cost full` —— 附加逐 turn 时间线（每 turn 的墙钟 / LLM ≈ / 工具 ≈ / token / 估算费用）
  - `/cost json` —— 机器可读输出，便于脚本与面板集成
- **跨会话汇总** —— 内置面板严格限于当前会话；「这周 / 这个工作区所有会话一共花了多少」只有这里能回答：
  - `/cost week` / `/cost month` / `/cost all` —— 按工作区聚合 + 按会话明细（按估算费用排序，附 token 与费用；后缀 `json` 输出机器可读格式）
- **`cost_report` 工具** —— 当你问"到目前为止花了多少"时，模型可以主动调用获取同一份报告
- **`costProfiler` 会话投影** —— 上述两者的数据源，同时暴露在客户端 wire 上，供面板类集成使用
- **渲染输出** —— 命令结果与工具卡片都以真 Markdown 渲染（见[输出渲染](#输出渲染)）

### 输出示例

```
Session cost $0.04 (est) · 2 turns · 27.6k in · 2.7k out · 88.5% cache hit · 58s wall

**Turns** 2 · **Messages** 2 · **Retries** 0
**Wall** 58s · **LLM ≈** 36.16s · **Tools ≈** 3.84s
**Tokens** 27.6k in · 213.1k cache hit (88.5%) · 2.7k out · 5.5k reasoning
**Estimated cost** $0.04 — API list prices (peak), USD

| Model route | In (uncached) | Cache hit | Cache write | Out | Reasoning | Msgs | Est. cost |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `deepseek/deepseek-v4-pro` | 15.2k | 115k | 0 | 1.9k | 3.4k | 1 | $0.03 |
| `deepseek/deepseek-flash` | 12.4k | 98.1k | 0 | 812 | 2.1k | 1 | $0.0053 |

**Slowest tools**

| Tool | Calls | Total | Max | Errors |
| --- | ---: | ---: | ---: | ---: |
| `bash` | 1 | 2.3s | 2.3s | 1 |
| `read_file` | 1 | 1.54s | 1.54s | 0 |
```

## 输出渲染

同一份报告文本在聊天界面里以 Markdown 渲染，表格就是表格，而不是裸露的管道符：

- `/cost` 的结果走聊天的 Markdown 渲染器（`conversation.chat.commandview` 槽），`cost_report` 调用走工具卡片槽（`tool.call.toolview`）。
- 折叠行的标签就是报告首行本身，而首行写成纯文本散文（`Session cost $0.04 (est) · 2 turns · …`），因此在任何不渲染 Markdown 的位置也读得通。
- 30 行以内的报告默认展开；更长的（繁忙会话的 `/cost full`）默认收起为那一行摘要 —— 点击行即可展开。
- `/cost json` 渲染为 JSON 代码块，可用代码块自带的复制按钮。
- 若客户端半边不可用（或 Markdown 渲染失败），卡片降级为宿主发出的等宽文本。报告全程都是纯文本 —— 模型看到的始终是文本，不是标记。

从没有客户端半边的版本升级上来时：插件组合会按进程缓存包的客户端声明，因此需要**完全重启应用**（仅刷新页面无效）后槽才会加载。

## 安装

在 DSH 内（Plugins 页面、插件管理工具或 CLI）：

```
dsh plugin --profile <profile> add dsh-cost-profiler
```

手动方式：把包加进 profile 的 `package.json` 依赖，并把包名加进 `dsh.profile.bundles`，然后在 profile 目录运行 `pnpm install`。bundle 自带 `cordis.patch.yml`，无需手工改组合配置。

## 工作原理

插件注册一个纯[会话投影](https://github.com/deepseek-ai/deepseek-harness)，把持久化会话事件（`assistant/message`、`tool/call` → `tool/result`、`turn/*`、`step/*`）折叠为：

- 按模型路由（`{provider}/{model}`）的 token 桶，含缓存读/写与推理 token —— 只取 `assistant/message` 的权威结算值，流式采样与中止的重试不会重复计数（与官方 token-usage 投影语义一致）；
- 由 `tool/call` → `tool/result` 事件时间差（按 `callId` 配对）得到的工具耗时，以及每个工具的调用次数、总耗时、最大耗时与错误数；
- turn 墙钟与 `LLM ≈` 估算（step 墙钟减去工具耗时）。

逐 turn 明细有上限（默认 100 turn），会话总量始终覆盖全程。状态为纯 JSON，可随投影 checkpoint 持久化。

## 费用估算

费用按 **API 牌价**计算并标注为估算值 —— 订阅/配额计费可能不同。内置 DeepSeek 公开模型的默认价目（峰值与低谷时段；低谷为峰值一半）。未配置价格的模型显示 `—`，而不是给出错误数字。

设置 `showCosts: false` 可完全关闭费用列，或在 profile 的 `cordis.patch.yml` 中按路由覆盖价格：

```yaml
- id: cost-profiler
  name: dsh-cost-profiler
  config:
    showCosts: true
    offPeak: false          # 用低谷价（峰值一半）估算
    currency: USD           # 费用显示币种
    detailTurns: 100        # /cost full 保留的逐 turn 明细条数
    prices:                 # 每百万 token 的价格
      deepseek/deepseek-flash: { input: 0.3, cacheRead: 0.006, cacheWrite: 0, output: 1.2 }
      # 也支持裸模型名或 "default" 键作为兜底
      default: { input: 1, output: 2 }
```

## 跨会话汇总

`/cost week`（还有 `month`、`all`）读取**本地已存储的会话**做汇总 —— 按工作区聚合 + 按会话明细（按估算费用排序）。内置面板严格限于当前会话，这类跨会话归因没有任何官方入口。

数据来源（按优先级）：

1. 本插件在该会话自己的 checkpoint（逐模型路由桶，定价最准）；
2. 应用的官方 `tokenUsage` checkpoint（只有会话总量、无路由 —— 按该会话最近使用的模型或你的 `default` 价定价）;
3. 直接重放会话日志（不依赖任何 checkpoint）。

说明：

- **只读且隐私有界**：扫描 `~/.dsh`（尊重 `$DSH_HOME`），只读标题、时间戳与用量/计时数字 —— 不碰消息正文 —— 且不写任何文件。
- 当前会话最后几条事件可能滞后一个 checkpoint 刷新周期（通常几秒）。
- 无剖析活动的会话会被跳过；窗口内没有数据时给出指向 `/cost all` 的提示，而不是空表。
- `cost_report` 模型工具刻意保持会话内范围 —— 跨会话大表会撑爆模型上下文。

## 说明与限制

- `LLM ≈` 由 step 计时推导，非逐请求精确计时 —— 视为近似值即可。
- 会话内剖析范围为当前会话（子代理会话各自独立）；跨会话汇总见上文。
- `/cost` 命令只输出文本，不进入模型上下文；`/cost json` 是面板类集成的接入点。
- 卡片小文案（运行态/JSON 标签/错误提示/代码块按钮）通过应用的 locale 注册表跟随界面语言（中/英）；报告正文由宿主半边生成，为英文。

## 兼容性

- DSH `0.2.0-rc.1` 及之后的 `0.2.0-rc.x`（peer 范围 `^0.2.0-rc.1`）、cordis `^4.0.1`、Node ≥ 20。
- 宿主半边为纯 ESM，无构建步骤、无原生模块。客户端半边是手写的 classic script（不走打包器），注册两个 UI 槽；聊天界面缺失时自动降级为纯文本。

## 开发

```
node --test      # 42 个单元测试：fold/report/prices/history 层 + 客户端半边
```

## 许可证

MIT —— 见 [LICENSE](./LICENSE)。
