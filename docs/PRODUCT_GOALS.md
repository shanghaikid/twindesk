# TwinDesk Product Goals

## 1. Purpose of This Document

This document defines the problems TwinDesk will solve, its product boundaries, core capabilities, and staged success criteria. Frameworks, models, and implementation languages may change, but the user value and safety boundaries defined here should remain stable.

## 2. One-Sentence Vision

Give one person multiple trusted, configurable, and traceable work personas that can process information from Feishu, Jira, and future systems in one local work console.

## 3. Problems to Solve

Knowledge workers have information and actions spread across chat, documents, issues, code repositories, and meetings. They repeatedly need to:

1. identify what truly requires their attention;
2. recover the project and historical context behind a message;
3. switch perspectives among technical lead, project owner, manager, and other roles;
4. draft an appropriate reply or next action;
5. synchronize progress between Feishu and Jira;
6. remember why a decision was made and what was ultimately executed.

General-purpose chatbots usually lack continuous event sources, explicit identities, tool permissions, durable records, and auditable execution boundaries. TwinDesk aims to complete this entire loop.

## 4. Initial User

The first stage serves a single user:

- uses Feishu and Jira daily;
- holds multiple work roles at the same time;
- is willing to let AI read explicitly authorized work context;
- wants AI to prepare drafts instead of speaking on their behalf without confirmation;
- requires data to remain primarily local and every processing run to be inspectable.

The first stage will not provide multi-user SaaS, an enterprise administration console, or an organization-wide knowledge platform.

## 5. Product Principles

### 5.1 Local First

Business databases, indexes, run records, and artifacts are stored on the local machine by default. Only the minimum context required to complete a task is sent to the selected model or external API.

### 5.2 Draft First

The default autonomy level is `draft_only`. Reads may run automatically. Writes to Feishu, Jira, or the filesystem must pass policy checks, and high-risk actions require user confirmation.

### 5.3 Separate Identity from Capability

A Persona defines who the agent is and how it judges and communicates. A Skill defines what it knows how to do. A Policy defines what it is allowed to do. Workflows and Teams define how work is coordinated. No layer implicitly grants the authority of another.

### 5.4 Traceable, Not Opaque

Every suggestion and action can be traced to source events, supplied context, run records, approval decisions, and external results. The system does not persist hidden model reasoning, but it does preserve user-readable decision summaries and tool traces.

### 5.5 Replaceable Components

Feishu, Jira, model providers, and the Agent Runtime connect through adapter boundaries. The product domain model does not depend on the raw data structures of any single service.

### 5.6 Single Agent by Default, Team on Demand

Routine message handling does not start a Team. Subagents, Workflows, or Agent Teams are used only when a task can be meaningfully decomposed, requires distinct specialist perspectives, or is explicitly assigned to a Team by the user.

## 6. Core Concepts

| Concept | Definition |
|---|---|
| Work Item | A normalized item that requires the user's attention, judgment, or action |
| External Event | An immutable source event from Feishu, Jira, or another system |
| Thread | Messages, issues, documents, and processing records grouped around one subject |
| Persona | A work persona's mission, tone, preferences, and default capability configuration |
| Skill | Discoverable and loadable knowledge or procedural instructions |
| Tool | A structured capability that reads data or executes an action |
| Policy | Rules for data access, autonomy, approval, and retention |
| Run | One Agent or Team processing execution |
| Draft | Suggested content or an action plan that has not been written to an external system |
| Approval | One-time user authorization for a specific external action |
| Artifact | A report, attachment, patch, export, or other generated output |

## 7. Core User Journeys

### 7.1 Replying to a Feishu Message

1. TwinDesk detects a group mention, a direct message to the Bot, or incrementally discovers a user-relevant message through user authorization.
2. The Inbox creates a Work Item and associates conversation context.
3. Routing rules select a default Persona, which the user may override.
4. The Persona retrieves the necessary Feishu history and related Jira information.
5. The system produces a reply draft and a short rationale.
6. The user edits or approves the draft.
7. The Connector sends the reply using an explicitly displayed identity.
8. The source, draft, approval, and send result are written to the local audit trail.

### 7.2 Processing a Jira Work Item

1. The Connector retrieves issue or comment changes through polling or Webhooks.
2. Rules determine whether the change is relevant to the user and requires action.
3. A Persona summarizes changes, risks, blockers, and recommended actions.
4. After approval, TwinDesk updates the comment, status, or assignee.
5. The result may optionally become a Feishu reply draft.

### 7.3 Complex Multi-Agent Work

1. The primary Persona determines that the task is suitable for decomposition, or the user selects a Team Template.
2. A Coordinator creates a task graph with budget and depth limits.
3. Roles such as Context Collector, Specialist, Drafter, and Critic work in parallel or sequence.
4. The Coordinator merges the results; child Agents cannot expand their own authority.
5. Every external write still passes through the shared approval boundary.

## 8. Persona Capabilities

Users can create multiple Personas. Each Persona supports at least:

- name, avatar, description, and mission;
- system instructions, communication tone, and output preferences;
- default model and reasoning-effort policy;
- available Skills and Tools;
- accessible data sources, chats, projects, and workspaces;
- memory scope and retention period;
- autonomy level;
- maximum tool-call, time, and model budgets;
- a default Team Template or a disabled Team setting;
- permission to use specialist Subagents such as Codex.

A Persona is not an independent account and cannot bypass the user's existing Feishu or Jira permissions.

## 9. Skill and Plugin Goals

Skills should support:

- user-authored prompt-only Skills;
- local directory discovery and hot reload;
- layered global, Persona, and project overrides;
- independent user-invocable and model-invocable policies;
- declared Connector, Tool, permission, and risk-level dependencies;
- import, export, and version pinning.

Executable plugins have a higher trust level and must be explicitly installed. Plugins generated temporarily by an Agent at runtime cannot automatically receive credentials or act as long-running background connectors.

## 10. Autonomy and Approval Levels

| Level | Behavior |
|---|---|
| `observe_only` | Read, archive, and summarize only |
| `draft_only` | Produce drafts without external writes; the default |
| `approve_then_act` | Execute a specific action after one-time user approval |
| `allowlisted_auto` | Automatically execute only allowlisted, low-risk actions |

Deletion, permission changes, bulk operations, public communication on the user's behalf, and irreversible actions cannot be automatically authorized through Persona configuration alone.

## 11. Feishu Scope and Limitations

The first version supports:

- direct messages received by the Bot and group mentions of the Bot;
- incremental search and context retrieval for messages visible under the user's OAuth identity;
- message replies, draft sending, and related attachment access;
- comment and mention context for known documents;
- explicit recording of whether a message was sent using Bot or User identity.

The product must not claim that a Feishu application inherently has access to all user messages. Actual visibility depends on application scopes, user authorization, Bot membership, and Feishu API restrictions. When document mentions cannot be represented as a reliable global real-time event, the UI must identify them as polling or notification-parsing results.

## 12. Jira Scope and Limitations

The first version supports:

- incremental synchronization of issues and comments relevant to the user;
- retrieval of issue context, status, assignee, priority, and links;
- approved comments and status transitions;
- association between Jira Work Items and Feishu Threads;
- polling in fully local mode and an optional Relay mode for more timely Webhook delivery.

A strictly local deployment cannot directly receive Jira Webhooks that require a publicly reachable HTTPS endpoint. The product must make the choice between polling and a stateless Relay explicit.

## 13. Records and Data Retention

Each Run records at least:

- the trigger source and external object ID;
- selected Persona, Skills, Tools, and model;
- context references supplied to the model and the applied redaction result;
- drafts, user edits, and final output;
- tool calls, approval requests, approval outcomes, and external API results;
- timestamps, duration, token usage, errors, and retries;
- generated Artifacts.

Records must be searchable, exportable, and deletable by source and time range. Credentials, hidden reasoning, environment variables, and unnecessary raw sensitive data must not enter ordinary logs.

## 14. MVP Scope

The MVP commits to one end-to-end loop:

> A Feishu event or incrementally discovered message enters the Inbox → a Persona is selected → necessary context is retrieved → a draft is generated → the user confirms → TwinDesk replies in Feishu → the complete trace is stored locally.

The MVP also includes:

- a local Web UI;
- at least two Personas;
- local Skills;
- one Feishu account;
- read-only related queries against one Jira site;
- Session logs and a business audit trail;
- drafts and one-time approvals;
- basic search and synchronization diagnostics.

## 15. MVP Non-Goals

- replying on the user's behalf without confirmation;
- reading every message belonging to the user in Feishu;
- multi-user operation, an organization administration console, or cloud collaboration;
- a plugin marketplace;
- a mobile application;
- a complex vector database or comprehensive enterprise knowledge index;
- allowing Agents to install or execute arbitrary third-party code;
- making experimental Agent Teams a critical dependency;
- recreating the complete Feishu or Jira client experience.

## 16. MVP Acceptance Criteria

The product qualifies as an MVP only when:

1. A new Feishu Work Item enters the Inbox reliably, without duplicating or losing committed records after restart.
2. The user can select at least two distinct Personas for a Work Item and receive drafts that are visibly different and consistent with their configurations.
3. Before a draft is sent, TwinDesk displays the target conversation, sending identity, and final content.
4. An external write configured to require approval cannot execute without that approval.
5. Every sent reply can be traced to its source message, draft, approval, and API result.
6. A failed Jira query does not block a Feishu draft, and the UI displays that context is incomplete.
7. OAuth tokens never appear in plaintext in the business database, Session logs, or diagnostic exports.
8. A Connector can resume from a durable synchronization cursor after restart.
9. The user can delete a selected Thread and the local TwinDesk data derived from it.
10. Compatibility tests detect a breaking DeepSeek Harness upgrade before release.

## 17. Future Directions

- bidirectional Jira operations and automatic association;
- enhanced Feishu document comment and mention support;
- Team Templates and dynamic Workflows;
- Codex as a code and repository specialist;
- local models and multi-model routing;
- desktop tray, system notifications, and quick actions;
- an optional stateless Webhook Relay;
- enterprise policy packs and shared team Skills while preserving personal data boundaries.
