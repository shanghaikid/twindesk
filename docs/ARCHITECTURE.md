# TwinDesk 架构方向

## 1. 架构结论

TwinDesk 第一版采用 DeepSeek Harness 作为 Agent Runtime，通过正式安装的 Cordis 插件扩展业务能力。暂不 fork Harness；若产品级 Inbox 无法通过现有客户端扩展点实现，只增加最小、通用的 UI Slot，并保持 TwinDesk 领域逻辑位于仓库外部。

DeepSeek Harness 是可替换基础设施，不是 TwinDesk 的领域模型。

## 2. 系统边界

```text
Feishu API / Events       Jira API / Webhooks
          │                         │
          ▼                         ▼
   Feishu Connector          Jira Connector
          └──────────┬──────────────┘
                     ▼
             Work Hub Service
        normalize / dedupe / route / sync
                     │
          ┌──────────┴──────────┐
          ▼                     ▼
   TwinDesk SQLite        DeepSeek Harness
  inbox/audit/cursors     sessions/agents/tools
          │                     │
          └──────────┬──────────┘
                     ▼
               TwinDesk Web UI
          inbox / drafts / approvals / traces
```

## 3. 插件与包划分

### `@twindesk/domain`

纯 TypeScript 领域类型和规则，不依赖 Cordis：

- ExternalEvent
- WorkItem
- ExternalThread
- Draft
- ActionProposal
- ApprovalRecord
- ConnectorCursor
- AuditRecord

### `@twindesk/storage-sqlite`

TwinDesk 业务数据库：

- schema 与迁移；
- inbox 和 thread 查询；
- 外部事件幂等写入；
- 同步游标；
- 草稿、审批和执行结果；
- 数据删除与导出。

它不直接写入 Harness 的 Session SQLite Schema。

### `@twindesk/plugin-work-hub`

Host 侧核心服务：

- Connector 注册表；
- 事件规范化与去重；
- Work Item 路由；
- Persona 选择；
- Run 与外部对象关联；
- 审批后的动作分发；
- 审计写入。

### `@twindesk/plugin-feishu`

- Bot 和 User OAuth 身份；
- 消息事件消费与增量查询；
- 消息、会话和文档上下文读取；
- 回复、发送和幂等键；
- 飞书 Tools 与 Skills；
- Scope 检查、速率限制和同步诊断。

### `@twindesk/plugin-jira`

- OAuth 2.0 或个人开发阶段 API Token；
- Issue/Comment 增量同步；
- JQL 查询；
- 评论和状态转换；
- Webhook Relay 可选适配；
- Jira Tools 与 Skills。

### `@twindesk/plugin-ui`

Host 和 Client 双侧插件：

- Inbox 页面；
- Persona 和 Skill 设置；
- 草稿编辑与审批；
- Connector 状态；
- Run、Tool、Audit 时间线。

### `@twindesk/bundle-workbench`

Profile Bundle，负责组合上述插件、默认 Agent Preset、模型工具和配置覆盖层。

## 4. Harness 能力映射

| TwinDesk 需求 | Harness 能力 | 使用方式 |
|---|---|---|
| 分身 | Agent Preset | 每个 Persona 生成或引用一个 Preset |
| 自定义技能 | Skill Registry | 全局、Persona、工作区分层提供 |
| 工具 | Tool Registry | Connector 注册读写工具 |
| 复杂委派 | Subagent | MVP 后启用，先于实验性 Team |
| Agent Team | Agent Teams / Workflow | 非关键路径、受预算限制 |
| 审批 | Approval Service | TwinDesk 写工具在执行前调用 |
| 会话留痕 | Session Persistence | 保存 Agent 事件和模型轨迹 |
| 后台运行 | Host Service / Jobs | Connector 使用 Host 生命周期；Agent 任务可使用 Jobs |
| 定时提醒 | Session Schedule | 只用于会话提醒，不承担 Connector 全局同步 |
| Codex | subagent-codex | 仅作为代码与仓库专家 |

## 5. 数据模型原则

### 5.1 外部对象不直接成为 Agent Session

一条飞书消息或 Jira Issue 先成为 ExternalEvent，再聚合为 WorkItem。只有用户或规则开始处理时，才创建或关联 Harness Session。

这避免每个噪声事件都产生模型调用和 Session。

### 5.2 原始事件不可变，派生状态可重建

Connector 对每个外部事件计算稳定幂等键：

```text
connector + tenant/account + object type + external id + version/update time
```

已接收的 ExternalEvent 仅追加；Inbox 状态、Thread 关联和未读计数从事件与显式用户操作派生。

### 5.3 两套持久化

- Harness Session Store：模型消息、工具事件、审批事件、Subagent/Team 历史；
- TwinDesk Store：外部事件、Inbox、同步游标、业务审计和保留策略。

两者通过稳定的 `session_id`、`run_id`、`work_item_id` 和外部引用关联。

## 6. 事件处理流程

```text
receive/poll
  → validate source
  → normalize
  → redact forbidden fields
  → idempotent append
  → update Work Item projection
  → route Persona
  → decide: notify / draft / ignore
  → build bounded context
  → run Agent or Workflow
  → save Draft / ActionProposal
  → request approval when required
  → execute through Connector
  → persist result and external receipt
```

所有写入型 Tool 必须支持幂等键，重试不能产生重复回复或重复 Jira 评论。

## 7. Connector 接口草案

```ts
interface Connector {
  readonly id: string

  start(signal: AbortSignal): Promise<void>
  sync(cursor: ConnectorCursor | undefined, signal: AbortSignal): Promise<SyncBatch>
  getContext(ref: ExternalRef, request: ContextRequest, signal: AbortSignal): Promise<ContextBundle>
  propose(action: ActionRequest): Promise<ActionProposal>
  execute(approved: ApprovedAction, signal: AbortSignal): Promise<ActionReceipt>
  health(): Promise<ConnectorHealth>
}
```

`propose()` 不产生外部副作用；`execute()` 只接受已绑定审批记录、目标和内容摘要的 `ApprovedAction`。

## 8. 安全模型

### 8.1 凭证

- OAuth refresh token 和 API token 保存到系统 Keychain 或独立加密 Secret Store；
- 数据库只保存 secret reference；
- 日志、错误、模型上下文和导出统一经过脱敏器；
- Bot 身份与 User 身份分开配置和展示。

### 8.2 工具风险

每个 Tool 声明：

- `read`、`write`、`destructive` 风险等级；
- 所需 Connector Scope；
- 是否支持预览；
- 是否要求审批；
- 幂等策略；
- 可作用的账号、群聊、项目和工作区范围。

### 8.3 Agent Team

- 子 Agent 默认继承更窄或相同权限，不能自行扩大；
- 子 Agent 不直接请求用户审批，由 Lead 汇总动作；
- 限制成员数、并发、深度、时间、Token 和 Tool 调用；
- Team 输出只是建议，外部写入仍经过统一 ActionProposal。

### 8.4 动态插件

Agent 动态生成的 Cordis 插件视为高信任代码：

- 不用于飞书/Jira 长期连接器；
- 不自动加载凭证；
- 不默认持久化或重启恢复；
- 运行前需要明确用户授权；
- 正式功能通过版本化 npm/Cordis 插件交付。

## 9. UI 信息架构

```text
Inbox
├── Needs reply
├── Needs review
├── Waiting
└── Done

Personas
├── Instructions
├── Skills & tools
├── Data scope
├── Autonomy
└── Team policy

Drafts & approvals
Connectors
Skills
Runs & audit
Settings
```

Work Item 详情页采用三栏：来源与上下文、草稿/行动区、Run 与审计时间线。

## 10. DeepSeek Harness 集成策略

由于 Harness 处于开发者预览：

1. 固定确切版本或 commit，不追随浮动版本；
2. 所有 Harness 类型只在 adapter 包出现；
3. 维护真实组合启动测试，而不只做单元测试；
4. 对 Agent Preset、Skill、审批、Session Persistence 和 Client Plugin 建兼容契约测试；
5. 升级单独提交，记录破坏性差异；
6. 不直接依赖未导出的源码路径；
7. 实验性 Agent Teams 不进入 MVP 关键链路。

## 11. 待验证问题

- Client Plugin 是否能稳定增加顶层 Inbox 路由和侧边栏入口；
- 外部插件构建所需的 client bundle preset 是否已经正式发布；
- Profile 中第三方插件安装、升级和版本固定的完整体验；
- Session SQLite 与业务 SQLite 同进程并发时的延迟；
- Host Service 在 Web UI 无浏览器连接时能否持续可靠同步；
- 飞书用户身份消息搜索的可见范围、速率限制和增量策略；
- Jira Cloud Webhook Relay 的部署与公司安全审批要求。
