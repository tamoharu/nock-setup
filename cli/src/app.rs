use crate::{
    backend::Backend,
    model::{safe_text, Snapshot, Tab, Target},
    terminal::{Terminal, TerminalCommand},
};
use serde_json::{json, Value};
use std::collections::HashSet;

#[derive(Clone, Debug, PartialEq)]
pub enum Focus {
    Content,
    Spaces,
    Agents,
}
#[derive(Clone, Debug, PartialEq)]
pub enum Surface {
    Chat,
    Terminal,
}
#[derive(Clone)]
pub enum Action {
    Machine(String),
    Space(String, String),
    Select(Target),
    New(bool),
    Surface(Surface),
    TabStep(i32),
}
pub struct Modal {
    pub title: String,
    pub prompt: String,
    pub text: String,
    pub command: Value,
    pub field: String,
    pub scroll: u16,
}
pub struct App {
    pub snapshot: Snapshot,
    pub active: Option<Target>,
    pub active_was_visible: bool,
    pub machine: String,
    pub space: String,
    pub collapsed: HashSet<String>,
    pub focus: Focus,
    pub surface: Surface,
    pub prefix: bool,
    pub help: bool,
    pub modal: Option<Modal>,
    pub draft: String,
    pub draft_revision: u64,
    pub message: String,
    pub spaces_scroll: usize,
    pub agents_scroll: usize,
    pub nav_index: usize,
    pub agent_index: usize,
    pub chat_scroll: u16,
    pub terminal: Option<Terminal>,
    pub terminal_request: Option<(u64, Target)>,
    pub sending: Option<(u64, Target, String)>,
    pub tick: usize,
    pub quit: bool,
}
impl Default for App {
    fn default() -> Self {
        Self {
            snapshot: Snapshot::default(),
            active: None,
            active_was_visible: false,
            machine: String::new(),
            space: String::new(),
            collapsed: HashSet::new(),
            focus: Focus::Spaces,
            surface: Surface::Chat,
            prefix: false,
            help: false,
            modal: None,
            draft: String::new(),
            draft_revision: 0,
            message: String::new(),
            spaces_scroll: 0,
            agents_scroll: 0,
            nav_index: 0,
            agent_index: 0,
            chat_scroll: 0,
            terminal: None,
            terminal_request: None,
            sending: None,
            tick: 0,
            quit: false,
        }
    }
}
impl App {
    pub fn tab(&self) -> Option<&Tab> {
        self.active.as_ref().and_then(|t| self.snapshot.tab(t))
    }
    pub fn tabs(&self) -> Vec<&Tab> {
        self.snapshot
            .machines
            .iter()
            .find(|m| m.id == self.machine)
            .and_then(|m| m.spaces.iter().find(|s| s.id == self.space))
            .map(|s| s.tabs.iter().collect())
            .unwrap_or_default()
    }
    pub fn send(&mut self, backend: &mut Backend, value: Value) -> Option<u64> {
        match backend.send(value) {
            Ok(id) => Some(id),
            Err(e) => {
                self.message = e.to_string();
                None
            }
        }
    }
    pub fn select(&mut self, backend: &mut Backend, target: Target) {
        let Some(tab) = self.snapshot.tab(&target).cloned() else {
            return;
        };
        if self.active.as_ref() != Some(&target) {
            self.terminal = None;
            self.terminal_request = None;
            self.draft.clear();
            self.draft_revision = 0;
            self.chat_scroll = 0;
            self.surface = if tab.kind == "shell" {
                Surface::Terminal
            } else {
                Surface::Chat
            };
        }
        self.machine = target.host_id.clone();
        self.space = tab.space_id.clone();
        self.focus = Focus::Content;
        self.active = Some(target.clone());
        self.active_was_visible = !tab.hidden;
        self.send(backend, json!({"action":"select", "target":target}));
        if tab.hidden && tab.fresh && !tab.dead {
            self.send(backend, json!({"action":"show", "target":target}));
        }
        if self.surface == Surface::Terminal {
            self.attach(backend);
        }
    }
    pub fn attach(&mut self, backend: &mut Backend) {
        if self.terminal.is_some() || self.terminal_request.is_some() {
            return;
        }
        if let Some(target) = self.active.clone() {
            if let Some(id) = self.send(backend, json!({"action":"terminal", "target":target})) {
                self.terminal_request = Some((id, target));
            }
        }
    }
    pub fn act(&mut self, backend: &mut Backend, action: Action) {
        match action {
            Action::Select(target) => self.select(backend, target),
            Action::Machine(id) => {
                let changed = self.machine != id;
                if self.machine == id {
                    if !self.collapsed.remove(&id) {
                        self.collapsed.insert(id.clone());
                    }
                } else {
                    self.collapsed.remove(&id);
                }
                self.machine = id;
                self.focus = Focus::Spaces;
                if changed {
                    let target = self
                        .snapshot
                        .tabs()
                        .find(|t| t.target.host_id == self.machine)
                        .map(|t| t.target.clone());
                    if let Some(target) = target {
                        self.select(backend, target);
                    } else {
                        self.active = None;
                        self.space.clear();
                        self.terminal = None;
                        self.terminal_request = None;
                        self.draft.clear();
                    }
                }
            }
            Action::Space(host, space) => {
                self.machine = host;
                self.space = space;
                if let Some(target) = self.tabs().first().map(|t| t.target.clone()) {
                    self.select(backend, target);
                } else {
                    self.active = None;
                    self.terminal = None;
                    self.terminal_request = None;
                    self.draft.clear();
                    self.focus = Focus::Spaces;
                }
            }
            Action::Surface(surface) => {
                self.surface = surface;
                self.focus = Focus::Content;
                if self.surface == Surface::Terminal {
                    self.attach(backend);
                }
            }
            Action::TabStep(delta) => {
                let tabs = self.tabs();
                if !tabs.is_empty() {
                    let current = tabs
                        .iter()
                        .position(|t| Some(&t.target) == self.active.as_ref())
                        .unwrap_or(0);
                    let index = (current as i32 + delta).rem_euclid(tabs.len() as i32) as usize;
                    let target = tabs[index].target.clone();
                    self.select(backend, target);
                }
            }
            Action::New(shell) => {
                let Some(machine) = self.snapshot.machines.iter().find(|m| m.id == self.machine)
                else {
                    return;
                };
                if !machine.connected {
                    self.message = "接続済みのマシンを選択してください。".into();
                    return;
                }
                let space = machine.spaces.iter().find(|s| s.id == self.space);
                self.modal = Some(Modal {
                    title: if shell {
                        "新しいシェル"
                    } else {
                        "新しいCodex"
                    }
                    .into(),
                    prompt: format!("{} 上のディレクトリの絶対パス", machine.name),
                    text: space
                        .map(|s| s.directory.clone())
                        .unwrap_or(machine.default_directory.clone()),
                    command: json!({"action":"create", "kind":if shell {"shell"} else {"codex"},
                        "target":{"hostId":machine.id,"serverId":machine.server_id}, "spaceId":space.map(|s| &s.id)}),
                    field: "directory".into(),
                    scroll: 0,
                });
            }
        }
    }
    pub fn save_draft(&mut self, backend: &mut Backend) {
        if let Some(target) = &self.active {
            if let Some(id) = self.send(
                backend,
                json!({"action":"draft", "target":target, "text":self.draft}),
            ) {
                self.draft_revision = id;
            }
        }
    }
    pub fn submit(&mut self, backend: &mut Backend) {
        if self.sending.is_some() {
            return;
        }
        if let Some(target) = self.active.clone() {
            if let Some(id) = self.send(
                backend,
                json!({"action":"send","target":target,"text":self.draft}),
            ) {
                self.sending = Some((id, target, self.draft.clone()));
            }
        }
    }
    pub fn approval(&mut self) {
        let Some(approval) = self
            .snapshot
            .detail
            .as_ref()
            .and_then(|d| d["approvals"].as_array())
            .and_then(|a| a.first())
        else {
            self.message = "確認待ちの操作はありません。".into();
            return;
        };
        let mut command =
            json!({"action":"answer", "target":self.active, "approvalId":approval["id"]});
        let method = approval["method"].as_str().unwrap_or_default();
        if method == "item/tool/requestUserInput" {
            let questions = approval["params"]["questions"]
                .as_array()
                .cloned()
                .unwrap_or_default();
            command["answers"] = json!({});
            command["questions"] = json!(questions);
            if let Some(question) = questions.first() {
                self.modal = Some(Modal {
                    title: "確認したいことがあります".into(),
                    prompt: question_prompt(question),
                    text: String::new(),
                    command,
                    field: "answer".into(),
                    scroll: 0,
                });
            }
        } else if [
            "item/commandExecution/requestApproval",
            "item/fileChange/requestApproval",
        ]
        .contains(&method)
        {
            self.modal = Some(Modal {
                title: "操作の承認".into(),
                prompt: safe_text(&format!(
                    "{}\n{}\n{}\n\naccept（許可） / decline（拒否）を入力",
                    approval["params"]["command"]
                        .as_str()
                        .unwrap_or("ファイル変更の承認"),
                    approval["params"]["cwd"].as_str().unwrap_or(""),
                    approval["params"]["reason"].as_str().unwrap_or("")
                )),
                text: String::new(),
                command,
                field: "decision".into(),
                scroll: 0,
            });
        } else {
            self.message = "この確認はモバイルまたはターミナルで回答してください。".into();
        }
    }
    pub fn finish_modal(&mut self, backend: &mut Backend) {
        let Some(mut modal) = self.modal.take() else {
            return;
        };
        if modal.text.trim().is_empty() {
            self.modal = Some(modal);
            return;
        }
        if modal.field == "answer" {
            let question = modal.command["questions"].as_array_mut().and_then(|q| {
                if q.is_empty() {
                    None
                } else {
                    Some(q.remove(0))
                }
            });
            if let Some(question) = question {
                let answer = modal
                    .text
                    .trim()
                    .parse::<usize>()
                    .ok()
                    .and_then(|n| n.checked_sub(1))
                    .and_then(|i| question["options"].as_array()?.get(i)?["label"].as_str())
                    .unwrap_or(modal.text.trim());
                if let Some(id) = question["id"].as_str() {
                    modal.command["answers"][id] = json!(answer);
                }
            }
            if let Some(next) = modal.command["questions"]
                .as_array()
                .and_then(|q| q.first())
            {
                modal.prompt = question_prompt(next);
                modal.text.clear();
                modal.scroll = 0;
                self.modal = Some(modal);
                return;
            }
            if let Some(object) = modal.command.as_object_mut() {
                object.remove("questions");
            }
        } else {
            if modal.field == "decision" && !["accept", "decline"].contains(&modal.text.trim()) {
                self.message = "accept または decline を入力してください。".into();
                self.modal = Some(modal);
                return;
            }
            modal.command[&modal.field] = json!(modal.text.trim());
        }
        self.send(backend, modal.command);
    }
    pub fn event(&mut self, backend: &mut Backend, value: Value, rows: u16, cols: u16) {
        match value["type"].as_str() {
            Some("snapshot") => {
                let Ok(next) = serde_json::from_value::<Snapshot>(value) else {
                    self.message = "CLIの同期応答を読み取れません。".into();
                    return;
                };
                if self.active == next.selected && next.draft_revision >= self.draft_revision {
                    self.draft = next.draft.clone();
                }
                self.snapshot = next;
                if self.machine.is_empty() {
                    self.machine = self
                        .snapshot
                        .machines
                        .first()
                        .map(|m| m.id.clone())
                        .unwrap_or_default();
                }
                if let Some(active) = self.active.clone() {
                    if self.snapshot.tab(&active).is_none()
                        || self.active_was_visible && self.tab().is_some_and(|t| t.hidden)
                    {
                        let replacement = self
                            .snapshot
                            .tabs()
                            .find(|t| {
                                t.target.host_id == active.host_id
                                    && t.target.tab_id == active.tab_id
                            })
                            .or_else(|| {
                                self.snapshot.tabs().find(|t| {
                                    t.target.host_id == active.host_id && t.space_id == self.space
                                })
                            })
                            .map(|t| t.target.clone());
                        self.active = None;
                        self.terminal = None;
                        self.terminal_request = None;
                        self.draft.clear();
                        if let Some(target) = replacement {
                            self.select(backend, target);
                        }
                    }
                    if self.tab().is_some_and(|t| !t.hidden) {
                        self.active_was_visible = true;
                    }
                } else {
                    let target = self
                        .snapshot
                        .tabs()
                        .find(|t| t.target.host_id == self.machine)
                        .map(|t| t.target.clone());
                    if let Some(target) = target {
                        self.select(backend, target);
                    }
                }
            }
            Some("result") => {
                let id = value["id"].as_u64().unwrap_or_default();
                if let Some(error) = value["error"].as_str() {
                    self.message = safe_text(error);
                } else if [
                    "refresh", "send", "show", "hide", "answer", "create", "resume",
                ]
                .contains(&value["action"].as_str().unwrap_or(""))
                {
                    self.message.clear();
                }
                if self
                    .terminal_request
                    .as_ref()
                    .is_some_and(|(request, _)| *request == id)
                {
                    let pending = self.terminal_request.take();
                    if pending.as_ref().map(|(_, t)| t) == self.active.as_ref()
                        && value["error"].is_null()
                    {
                        match serde_json::from_value::<TerminalCommand>(
                            value["result"]["terminal"].clone(),
                        )
                        .map_err(|e| e.to_string())
                        .and_then(|c| Terminal::start(c, rows, cols).map_err(|e| e.to_string()))
                        {
                            Ok(terminal) => {
                                self.terminal = Some(terminal);
                                self.message.clear();
                            }
                            Err(error) => self.message = error,
                        }
                    }
                }
                if self
                    .sending
                    .as_ref()
                    .is_some_and(|(request, _, _)| *request == id)
                {
                    if let Some((_, target, text)) = self.sending.take() {
                        if value["error"].is_null()
                            && self.active.as_ref() == Some(&target)
                            && self.draft == text
                        {
                            self.draft.clear();
                        }
                    }
                }
                if let Some(tab_id) = value["result"]["tabId"].as_str() {
                    let host = value["result"]["hostId"].as_str().unwrap_or_default();
                    let target = self
                        .snapshot
                        .tabs()
                        .find(|t| t.target.host_id == host && t.target.tab_id == tab_id)
                        .map(|t| t.target.clone());
                    if let Some(target) = target {
                        self.select(backend, target);
                    }
                }
            }
            Some("disconnected") => {
                self.message = value["error"].as_str().unwrap_or_default().into();
                self.terminal = None;
            }
            Some("error") => self.message = safe_text(value["error"].as_str().unwrap_or_default()),
            _ => {}
        }
    }
}
fn question_prompt(question: &Value) -> String {
    let options = question["options"]
        .as_array()
        .map(|items| {
            items
                .iter()
                .enumerate()
                .map(|(i, o)| {
                    format!(
                        "{}. {}  {}",
                        i + 1,
                        o["label"].as_str().unwrap_or(""),
                        o["description"].as_str().unwrap_or("")
                    )
                })
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default();
    safe_text(&format!(
        "{}\n\n{}\n\n番号を入力するか、自由に回答してください。",
        question["question"].as_str().unwrap_or(""),
        options
    ))
}
