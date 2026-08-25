# TwinDesk 实施路线

## 阶段 0：Harness 适配性验证

目标：在投入产品开发前，证明关键能力可以通过仓库外插件完成。

- 固定一个 DeepSeek Harness 版本；
- 创建最小 Profile Bundle；
- 创建 Host 插件并注册一个只读 Tool；
- 创建 Client 插件并验证设置卡片；
- 验证能否添加顶层 Inbox 页面和导航入口；
- 创建两个 Agent Preset；
- 启用 Session 持久化并验证重启恢复；
- 验证 `subagent-codex` 的安装与一次委派；
- 记录必须修改 Harness 核心的最小列表。

退出条件：可以在不 fork 或只增加一个通用 UI Slot 的前提下构建产品体验。

## 阶段 1：本地 Work Hub

目标：建立无外部副作用的领域与存储层。

- ExternalEvent、WorkItem、Thread、Draft 数据模型；
- SQLite schema、迁移、幂等写入和同步游标；
- Inbox API 与基础页面；
- Persona 配置与 Harness Preset 映射；
- 本地 Audit Timeline；
- 凭证引用与统一脱敏器；
- 测试重启、重复事件、游标回退和数据删除。

退出条件：可以用 fixture 事件完成 Inbox → Persona → Draft → Audit。

## 阶段 2：飞书闭环 MVP

目标：完成第一个真实端到端价值链。

- Bot 消息事件；
- 用户身份增量消息读取；
- 上下文获取与附件引用；
- 飞书回复 Tool；
- Draft 编辑；
- 一次性审批；
- 幂等发送；
- Connector 健康与权限诊断。

退出条件：一条真实飞书消息可以安全地产生、批准并发送回复，且全程可追溯。

## 阶段 3：Jira 上下文

目标：让飞书草稿能够使用项目事实。

- Jira OAuth/API Token；
- Issue 与 Comment 增量同步；
- JQL 搜索 Tool；
- Work Item 与 Issue 关联；
- Jira 不可用时的降级与上下文不完整提示；
- Jira 写操作先保持关闭或只在实验开关下启用。

退出条件：飞书草稿可以引用可验证的 Jira 状态，同时 Jira 失败不阻断主流程。

## 阶段 4：多分身与专业 Subagent

目标：把“多个我的分身”做成可理解、可控制的产品能力。

- Persona 编辑器；
- Skill 选择与覆盖可视化；
- 工具和数据范围；
- 自治等级与预算；
- Codex 代码专家；
- Drafter/Critic 等一次性 Subagent；
- 运行成本和结果对比。

退出条件：用户能解释每个 Persona 的身份、能力和权限差异，并能预测其行为边界。

## 阶段 5：Team、自动化与桌面体验

目标：在已有安全闭环上增加复杂协作能力。

- Team Template；
- 动态 Workflow；
- 实验性 Agent Teams 评估；
- Jira 写操作；
- 白名单低风险自动化；
- Webhook Relay；
- 桌面壳、托盘和系统通知。

该阶段不应早于真实 MVP 使用反馈。

## 开发约束

- 每个阶段必须包含重启恢复测试；
- 每个外部写操作必须包含幂等测试；
- 每次 Harness 升级必须运行组合兼容测试；
- 任何包含凭证或公司数据的日志字段必须先通过脱敏测试；
- 实验性能力必须受 feature flag 控制；
- 产品验收以用户闭环为单位，不以创建包或接口数量为单位。
