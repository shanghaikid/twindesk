# TwinDesk

TwinDesk 是一个本地优先的个人工作代理台。它把飞书、Jira 等工作系统中的信息汇集到统一 Inbox，让用户用多个可配置的“工作分身”理解上下文、准备回复、推进任务，并在明确的权限边界内执行操作。

> TwinDesk 是当前工作名，尚未进行商标与域名核验。

## 产品定位

TwinDesk 不是一个自动回复机器人，也不是另一个通用聊天窗口。它是用户本人控制的工作操作台：

- 统一接收和整理飞书消息、文档提及、Jira Issue 与评论；
- 为不同工作身份配置 Persona、Skill、工具权限与记忆范围；
- 简单任务由单 Agent 完成，复杂任务可动态组织 Agent Team；
- 默认只生成草稿，外部写操作经过审批后执行；
- 在本地保存来源、上下文、草稿、审批、工具调用和最终结果；
- Agent Runtime、模型和外部连接器均保持可替换。

## 当前技术方向

第一版基于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 构建，采用插件优先策略：

- DeepSeek Harness 提供 Agent Loop、Session、Skill、Subagent、Workflow、审批和 Web UI；
- TwinDesk 提供 Work Inbox、外部事件模型、Persona 产品体验、业务审计和数据保留策略；
- 飞书与 Jira 分别作为独立 Connector 插件实现；
- Agent 会话日志与 TwinDesk 业务数据分库存储；
- 不把产品领域模型耦合到 DeepSeek、Codex 或某个单一模型供应商。

DeepSeek Harness 当前仍处于开发者预览阶段，因此集成层必须固定兼容版本，并与 TwinDesk 领域代码隔离。

## 文档

- [产品目标](docs/PRODUCT_GOALS.md)：愿景、用户场景、范围、验收标准和非目标。
- [架构方向](docs/ARCHITECTURE.md)：插件划分、数据边界、事件流、安全模型和技术风险。
- [实施路线](docs/ROADMAP.md)：从技术验证到可用 MVP 的交付顺序。

## 当前状态

项目处于产品定义与技术验证阶段，尚未开始生产实现。
