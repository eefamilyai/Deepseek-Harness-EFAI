# DeepSeek Direct（`ds_direct.py`）

[English](README.ds-direct.md) | 中文

**直连 chat.deepseek.com**——无代理，无第三方 API 服务器。

`ds_direct` 是让 harness 把**免费**的 DeepSeek 网页账号用作模型后端的连接器。
它是旧有 `localhost:8000` `deepseek-free-api` 代理的直接替代：它用 DeepSeek 自己的
WASM 求解 DeepSeek 的浏览器 Proof-of-Work，为每个会话持有一个常驻聊天，并把网页
客户端的流式 SSE 格式翻译成运行时其余部分所期望的 `reasoning` / `content` 增量。

> **它驱动的是普通网页登录，而非付费平台 API。** 你提供的是浏览器所用的同一个
> bearer token 和 cookie。请据此对待它：它面向个人/实验用途，并受 DeepSeek 自身的
> 速率限制与条款约束。

---

## 快速开始

1. 在浏览器中于 <https://chat.deepseek.com> **登录**。
2. 打开 **DevTools → Network**，发送任意消息，点击 `/completion` 请求。从中复制：
   - **`authorization`** 头中 `Bearer ` *之后*的值 → 你的 **token**
   - 完整的 **`cookie`** 头 → 你的 **cookie** 字符串
     （至少需要 `cf_clearance`、`aws-waf-token` 和 DeepSeek 的会话 cookie——
     整体复制最省事且安全）。
3. 在 `ds_direct.py` 旁创建 **`ds_config.json`**：

   ```json
   {
     "token": "<bearer token, no 'Bearer ' prefix>",
     "cookie": "cf_clearance=...; aws-waf-token=...; ds_session_id=..."
   }
   ```

4. 启动 harness。一旦存在可用的 token（或具备登录能力的账号），`configured()` 即
   翻转为 true，DeepSeek 模型随之出现在选择器中。

`ds_config.json` 已被 **git 忽略**，并持有你实时凭据的*唯一*副本。请让它远离共享/
同步文件夹，且永不提交。

### 自动刷新（推荐）

粘贴的 token 会过期。若希望 `ds_direct` 在遇到 `401` 时自行铸取新 token，而不必你
从 DevTools 重新粘贴，请补充登录凭据：

```json
{
  "token": "<optional; will be refreshed automatically>",
  "cookie": "<optional; refreshed on login>",
  "email": "you@example.com",
  "password": "<your DeepSeek password>"
}
```

用手机号代替邮箱登录：

```json
{ "mobile": "1234567890", "area_code": "+86", "password": "<password>" }
```

设置了 `email`/`mobile` + `password` 后，过期的 token 会在会话中途透明刷新——无需
重启。登录过程中遇到的 AWS-WAF 挑战会经由 [`ds_waf.py`](ds_waf.py) 自动求解。

---

## 配置参考

| 键 | 含义 |
| --- | --- |
| `token` | 来自网页客户端的 bearer token（不带 `Bearer ` 前缀）。 |
| `cookie` | Cookie 头字符串；携带 WAF/Cloudflare token。随 DeepSeek 的滑动更新自动刷新并持久化。 |
| `email` / `mobile` + `area_code` | 用于自动刷新 token 的登录身份。 |
| `password` | 登录密码。从不记录日志、从不返回，除 DeepSeek 登录端点外从不发往任何地方。 |
| `headers` | 可选对象，逐字复制的额外请求头（见 [`x-hif-*` 说明](#the-x-hif--headers)）。 |
| `accounts` | 可选数组，元素为上述对象，每个登录一项——见[多账号](#multiple-accounts)。 |

**环境变量覆盖**

| 变量 | 作用 |
| --- | --- |
| `KILN_DS_CONFIG` | 源码树之外的 `ds_config.json` 绝对路径（先于本地文件检查）。 |
| `KILN_STATE_DIR` | `ds_sessions.json`（会话 → DeepSeek 聊天映射）的写入位置。使可变状态留在只读的 vendored 运行时之外。 |
| `DEEPSEEK_TOKEN` / `DEEPSEEK_COOKIE` / `DEEPSEEK_EMAIL` / `DEEPSEEK_MOBILE` / `DEEPSEEK_AREA_CODE` / `DEEPSEEK_PASSWORD` | 直接来自环境的账号 `#0`（无需文件）。 |

配置文件是**热重载**的——编辑它（例如粘贴新 token）会在下一轮生效，无需重启。写入
是原子的，因此 token 刷新绝不会截断文件把你登出。

---

## 模型

`ds_direct` 暴露若干 id，映射到 DeepSeek 的网页档位与开关。每个 id 是
`(model_type, thinking, search)`：

| 模型 id | 标签 | 档位 | 思考 | 联网搜索 |
| --- | --- | --- | --- | --- |
| `deepseek-default` | DeepSeek | default | – | – |
| `deepseek-reasoner` | DeepSeek · Reasoner | default | ✓ | – |
| `deepseek-search` | DeepSeek · Search | default | – | ✓ |
| `deepseek-reasoner-search` | DeepSeek · Reasoner + Search | default | ✓ | ✓ |
| `deepseek-expert` | DeepSeek · Expert | expert | ✓ | – |
| `deepseek-expert-reasoner` | DeepSeek · Expert Reasoner | expert | ✓ | – |
| `deepseek-expert-offline` | DeepSeek · Expert Reasoner (web off) | expert | ✓ | – |
| `deepseek-expert-search` | DeepSeek · Expert Search | expert | – | ✓ |
| `deepseek-vision` | DeepSeek · Vision | vision | – | – |
| `deepseek-vision-reasoner` | DeepSeek · Vision Reasoner | vision | ✓ | – |

> **expert 档位为何默认关闭搜索。** 发送 `search_enabled: true` 会告诉网页模型有
> 工具可用，从而诱使它输出自身的原生工具调用标记（DSML）而非围栏代码块——而在此
> 端点上并没有任何东西可以分派该标记。对需要搜索的对话，联网搜索仍在显式的
> `*-search` id 上可用。

---

## 工作原理

```
stream(model, messages, conv_id, …)
  └─ pick account (sticky per conversation)         _account_order / _lease_client
  └─ resolve the DeepSeek chat for this conv        _get_state → ds_sessions.json
  └─ build the per-turn prompt (delta only)         _prompt_for / messages_to_prompt
  └─ solve Proof-of-Work                             solve_pow (Node+WASM → python fallback)
  └─ POST /chat/completion  (streaming)              _Client.open_completion
  └─ parse SSE fragments → (kind, text) deltas       _parse
  └─ yield {type: reasoning|content|refs|title|meta}
```

**每个会话一个常驻聊天。** 每个 harness 会话都被钉到恰好一个 DeepSeek 聊天会话
（`ds_sessions.json`），因此历史存放在服务端，并能挺过重启、跨天或 token 刷新——
只要账号不变。首轮之后只发送**新增**消息（`_prompt_for`），绝不发送整份记录。

**Proof-of-Work。** DeepSeek 在 PoW 挑战之后才放行 `/chat/completion` 与
`/file/upload_file`。`ds_direct` 通过 Node 运行 DeepSeek 自己的
`sha3_wasm_bg.wasm` 以求速度（`_pow_solver.cjs`，首次使用时生成），并在 Node 不可
用时回退到纯 Python SHA3（更慢——它会打印警告，使静默的降速可见）。该 WASM 会缓存
在本地，若尚不存在则从 DeepSeek 的 CDN 获取。

**Token 计量。** 由于网页端点不计费，`_turn_usage` 会对 DeepSeek 真实的前缀缓存
建模（64 token 一块；短于一块的前缀永不命中），使 harness 的用量/成本显示有意义。
输出计的是*总*生成量（可见部分 + 思考部分）；`reasoning` 保留仅思考的子集。

### 韧性

`ds_direct` 区分不同的失败类别，并对每一类做出正确响应：

| 情况 | 响应 |
| --- | --- |
| `401` / token 失效 | 用保存的密码重新登录（若已配置），在**同一个**聊天中重试。 |
| `parent_message_id` 被拒（`400`/`422`） | 重置线程关系，在**同一个**聊天中重试——不要放弃它。 |
| 未知会话（`404` / "invalid chat session id"） | 开一个**新的**聊天，重新预热一次。 |
| "Server is busy" | 等待 `DS_BUSY_WAIT`（5 秒）后重发——它会自行缓解。 |
| 速率限制（`429` / "too frequent"） | 等待 `DS_RATE_WAIT`（3 分钟）后重发——这是配额窗口，不是抖动。 |
| "Length limit reached"（聊天已满） | 抛出 harness 能识别的上下文溢出 → 它会压缩并在新聊天中重试。 |

一个会话**留在它的账号上**：瞬时失败会在同一登录上等待并重试，而不是跳转，因为切换
账号会放弃服务端的聊天历史。切换账号是手动选择（在模型选择器中挑另一个账号路由）。

---

## 多账号

为把负载分摊到多个免费登录上——使并行的 agent 不在同一会话上争用，并让繁忙/被封的
账号可以故障转移——将它们列出：

```json
{
  "accounts": [
    { "id": "main",  "email": "a@example.com", "password": "…" },
    { "id": "alt",   "mobile": "1234567890", "area_code": "+86", "password": "…" }
  ]
}
```

- 顶层的普通 `{ "token", "cookie", … }` 仍然是账号 `#0`——该数组是追加式的，向后兼容。
- 新会话按轮转分配；随后每个会话固定在自己的账号上。
- harness 为**每个账号注册一条模型路由**，因此你可以把 subagent 钉到与其父级不同的登录上。
- 用 `add_account(email, password, …)` 在运行时添加账号：它会登录、验证 token 可用，然后把该账号持久化到 `ds_config.json`。

---

## 公共 API

由 `providers.py` / `server.py` 消费：

| 函数 | 用途 |
| --- | --- |
| `configured()` | 若任一账号能服务请求（持有 token，或能够登录）则为 True。 |
| `models()` | 可用的模型 id（在配置完成前为空）。 |
| `is_dsfree(model)` | 对本连接器拥有的 `deepseek-*` id 返回 True。 |
| `account_ids()` | 已配置账号 id 的稳定列表（仅 id——绝不含凭据）。 |
| `stream(model, messages, conv_id=…, account=…, …)` | 生成 `{type: reasoning\|content\|refs\|title\|meta, …}` 增量的生成器。主入口点。 |
| `messages_to_prompt(messages)` | 把带角色标记的消息列表压平为网页端点所接受的单个 prompt 字符串。**不添加任何指令。** |
| `describe_files(files, prompt, …)` | 视觉：上传图片并返回 `{name: description}`。 |
| `add_account(email, password, …)` | 测试一个登录并将其持久化为新的池化账号。 |

> `messages_to_prompt` 刻意**不**注入任何由提供方撰写的引导——它只是给调用方自己的
> 轮次重新贴标签（`User:` / `Assistant:` / `[Tool result]:`），并追加一个收尾的
> `Assistant:` 补全提示。任何人设或工具协议文本都由系统提示词的拥有者负责。

---

## 视觉与文件上传

图片描述走**一个共享的视觉聊天**（而非每个会话一个）：开一个聊天要花费一次会话调用
外加一次 PoW 求解，而这些描述彼此独立，也与你所处的聊天无关。每个文件独立上传，因此
一个坏文件只让它自己失败；多文件回复会尽力拆回成每个文件一份描述。

上传需要 DeepSeek 能识别的内容类型（它据此路由），并需要为上传路径铸取**各自的**
PoW 挑战。

---

## 故障排查

**`curl-cffi unavailable in the server's Python`**——几乎总是因为服务器是在项目虚拟
环境之外启动的（用了 `PATH` 上的裸 `python`），而不是缺少这个包。请用项目 venv 启动；
若仍无法导入，执行 `uv sync`。

**`No DeepSeek token`**——没有可用账号。在 `ds_config.json` 中设置 `token`，*或*设置
`email`/`mobile` + `password`。仅凭据本身即是一份完整配置（token 会在首次使用时铸取）。

**`DeepSeek auth failed` 且始终不恢复**——WAF 需要一个由浏览器求解的 token，重试无法
产生它。请从 DevTools 粘贴新的 `token` + `cookie`，或设置 `email` + `password` 以自动
刷新。

**回答显示为"思考"然后停住**——历史上是一个片段类型标注的缺陷；解析器现已正确处理
`THINK → RESPONSE` 类型翻转以及字典形态的 `fragments APPEND` 事件。若你仍遇到，请用
`--debug` 捕获原始 SSE。

### `x-hif-*` 头

DeepSeek 的网页客户端会发送一对 `x-hif-*` 反滥用头——由混淆 JS 铸造的 AES-GCM 数据块，
**无法在此处计算**，只能捕获并重放。它们被刻意*不*硬编码（写死的常量会过期，而一个值
被永久重放比什么都不发是更明显的机器人信号）。若你确实需要它们，请从一次实时的
`/completion` 请求中把它们复制到 `ds_config.json` 的 `headers` 对象里；它们会被逐字应用。

---

## 文件

| 文件 | 角色 |
| --- | --- |
| `ds_direct.py` | 本连接器。 |
| `ds_waf.py` | 登录期间使用的 AWS-WAF 挑战自动求解器。 |
| `ds_config.json` | **你的凭据。已被 git 忽略。永不提交。** |
| `ds_sessions.json` | 会话 → DeepSeek 聊天映射（自动管理；遵循 `KILN_STATE_DIR`）。 |
| `sha3_wasm_bg.wasm` / `_pow_solver.cjs` | PoW 资产（首次使用时缓存/生成）。 |

---

## 安全说明

- 凭据**仅**存放在 `ds_config.json`（已被 git 忽略）。请让它远离共享/同步驱动器。
- 密码从不记录日志、从不跨 API 边界返回，也从不作为命令行参数传递。
- 在操作系统支持的情况下，配置写入为属主可读写（`0o600`），且是原子的，因此刷新不会
  损坏或截断文件。
