//! Built-in AI assistant (移动端内置 Agent)。
//!
//! 一个自包含的轻量 ReAct 运行时：直接驱动 OpenAI-compatible
//! Chat Completions（SSE），工具层建在 `flowix-core` 的 `NoteService` 之上，
//! 只暴露当前笔记本作用域内的笔记操作。
//!
//! 与桌面外部 CLI Agent（`agent_external`）完全独立：不共享运行时注册表、
//! 路径配置或工具；唯一共享的是产品级 wire 协议（`AgentChunk` /
//! `agent-chunk` 事件 + `thread.db` 线程存储），前端会话 UI 因此可以直接复用。
//!
//! 模块结构：
//! - [`config`] — 独立的助手配置（`boot/builtin-ai.json`），与桌面
//!   agent-config / Pi / DSH 配置互不影响；
//! - [`provider`] — 无状态的 chat-completions SSE 客户端；
//! - [`tools`] — 笔记工具定义与执行（当前笔记本沙箱 + CAS 保护）；
//! - [`runtime`] — 工具循环、事件派发、取消与持久化；
//! - [`commands`] — 配置 IPC。

pub(crate) mod commands;
mod config;
mod provider;
mod rich_content;
mod runtime;
mod tools;
mod web_search;

pub use runtime::BuiltinAiService;

/// 内置助手在 wire / thread.db 里使用的固定 agent id。
pub const AGENT_ID: &str = "flowix";
