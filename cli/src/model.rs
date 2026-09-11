use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct Target {
    pub host_id: String,
    pub server_id: String,
    pub tab_id: String,
    pub thread_id: Option<String>,
    pub source: String,
}
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Tab {
    #[serde(flatten)]
    pub target: Target,
    pub name: String,
    pub host_name: String,
    pub space_id: String,
    pub space_name: String,
    pub directory: String,
    pub state: String,
    pub status: String,
    pub runtime: String,
    pub query: String,
    pub latest: String,
    pub kind: String,
    pub fresh: bool,
    pub hidden: bool,
    pub dead: bool,
}
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default)]
pub struct Space {
    pub id: String,
    pub name: String,
    pub directory: String,
    pub tabs: Vec<Tab>,
}
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Machine {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub server_id: String,
    pub connected: bool,
    pub status: String,
    pub error: String,
    pub spaces: Vec<Space>,
    pub default_directory: String,
}
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Preferences {
    pub filter: String,
    pub by_priority: bool,
    pub include_archived: bool,
}
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default)]
pub struct Snapshot {
    pub machines: Vec<Machine>,
    pub agents: Vec<Tab>,
    pub selected: Option<Target>,
    pub detail: Option<Value>,
    pub draft: String,
    #[serde(rename = "draftRevision")]
    pub draft_revision: u64,
    pub pending: Vec<Value>,
    pub preferences: Preferences,
}
impl Snapshot {
    pub fn tabs(&self) -> impl Iterator<Item = &Tab> {
        self.machines
            .iter()
            .flat_map(|m| &m.spaces)
            .flat_map(|s| &s.tabs)
    }
    pub fn tab(&self, target: &Target) -> Option<&Tab> {
        self.tabs()
            .chain(self.agents.iter())
            .find(|t| t.target == *target)
    }
}

pub fn safe_text(text: &str) -> String {
    text.chars()
        .filter(|c| !c.is_control() || *c == '\n' || *c == '\t')
        .collect()
}
