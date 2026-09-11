// Adapted from Herdr v0.7.5 src/ui/{tabs,sidebar}.rs. See third-party/herdr.
// hati adaptation: 2026-09-10.
// View geometry is computed before rendering; drawing never changes app state.
use crate::{
    app::{Action, App, Focus, Surface},
    model::Tab,
    terminal::TerminalView,
    text::{display_width_u16, middle_elide, truncate_end},
};
use ratatui::{
    layout::Rect,
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Clear, Paragraph, Wrap},
    Frame,
};

pub const BG: Color = Color::Rgb(30, 30, 46);
pub const PANEL: Color = Color::Rgb(24, 24, 37);
pub const SURFACE: Color = Color::Rgb(49, 50, 68);
pub const TEXT: Color = Color::Rgb(205, 214, 244);
pub const MUTED: Color = Color::Rgb(127, 132, 156);
pub const ACCENT: Color = Color::Rgb(137, 180, 250);
pub fn state_color(tab: &Tab) -> Color {
    if !tab.fresh {
        return MUTED;
    }
    match tab.state.as_str() {
        "running" | "starting" => Color::Rgb(255, 149, 0),
        "waiting" | "failed" => Color::Rgb(243, 139, 168),
        "completed" => Color::Rgb(166, 227, 161),
        _ => MUTED,
    }
}
pub fn glyph(tab: &Tab, tick: usize) -> &'static str {
    if !tab.fresh {
        return "?";
    }
    match tab.state.as_str() {
        "running" | "starting" => ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"][tick % 10],
        "waiting" => "⋮",
        "completed" => "✓",
        "failed" => "!",
        "unknown" | "untracked" => "?",
        "stopped" => "−",
        _ => "○",
    }
}
pub fn tab_label(tab: &Tab, tick: usize) -> String {
    format!(
        "{} {} · {} {}",
        glyph(tab, tick),
        truncate_end(&tab.name, 14),
        tab.status,
        tab.runtime
            .strip_prefix("実行時間 ")
            .unwrap_or(&tab.runtime)
    )
}
#[derive(Clone)]
pub struct NavRow {
    pub text: String,
    pub action: Action,
    pub machine: bool,
    pub selected: bool,
}
pub fn navigation(app: &App) -> Vec<NavRow> {
    let mut rows = Vec::new();
    for machine in &app.snapshot.machines {
        rows.push(NavRow {
            text: format!(
                "{} {}  {} {}",
                if app.collapsed.contains(&machine.id) {
                    "▸"
                } else {
                    "▾"
                },
                machine.name,
                if machine.kind == "ssh" {
                    "SSH"
                } else {
                    "local"
                },
                machine.status
            ),
            action: Action::Machine(machine.id.clone()),
            machine: true,
            selected: app.machine == machine.id,
        });
        if app.collapsed.contains(&machine.id) {
            continue;
        }
        for space in &machine.spaces {
            rows.push(NavRow {
                text: format!("  {}  {}", space.name, space.tabs.len()),
                action: Action::Space(machine.id.clone(), space.id.clone()),
                machine: false,
                selected: app.machine == machine.id && app.space == space.id,
            });
        }
    }
    rows
}
pub struct View {
    pub sidebar: Rect,
    pub spaces: Rect,
    pub agents: Rect,
    pub tab_area: Rect,
    pub content: Rect,
    pub footer: Rect,
    pub nav: Vec<NavRow>,
    pub tab_rects: Vec<Rect>,
    pub hits: Vec<(Rect, Action)>,
}
// Herdr sidebar_section_heights and expanded_sidebar_sections, adapted for
// explicit machine headers above hati Spaces and the global Agents section.
fn sections(area: Rect) -> (Rect, Rect) {
    let height = area.height;
    let first = if height < 6 {
        height.div_ceil(2)
    } else {
        ((height as f32 * 0.40).round() as u16).clamp(3, height - 3)
    };
    (
        Rect::new(area.x, area.y, area.width, first),
        Rect::new(area.x, area.y + first, area.width, height - first),
    )
}
// Herdr's width-aware tab hit areas, with hati execution labels and a fixed
// new-tab affordance. Always bring the active tab into the visible interval.
pub fn layout_tabs(labels: &[String], area: Rect, active: usize) -> Vec<Rect> {
    let mut rects = vec![Rect::default(); labels.len()];
    if area.width == 0 || area.height == 0 || labels.is_empty() {
        return rects;
    }
    let widths: Vec<_> = labels
        .iter()
        .map(|s| display_width_u16(s).saturating_add(3).max(8))
        .collect();
    let mut start = active.min(labels.len() - 1);
    let mut used = widths[start].min(area.width);
    while start > 0 && used.saturating_add(widths[start - 1] + 1) <= area.width {
        start -= 1;
        used += widths[start] + 1;
    }
    let mut x = area.x;
    for i in start..labels.len() {
        let remaining = area.right().saturating_sub(x);
        if remaining == 0 {
            break;
        }
        let width = widths[i].min(remaining);
        rects[i] = Rect::new(x, area.y, width, 1);
        x = x.saturating_add(width + 1);
    }
    rects
}
pub fn compute(app: &App, area: Rect) -> View {
    let width = if area.width < 70 {
        0
    } else {
        (area.width / 3).clamp(28, 42)
    };
    let sidebar = Rect::new(area.x, area.y, width, area.height.saturating_sub(1));
    let (spaces, agents) = sections(sidebar);
    let right = Rect::new(
        area.x + width,
        area.y,
        area.width.saturating_sub(width),
        area.height.saturating_sub(1),
    );
    let tab_area = Rect::new(right.x, right.y, right.width, 1.min(right.height));
    let nav = navigation(app);
    let mut hits = Vec::new();
    for (i, row) in nav
        .iter()
        .skip(app.spaces_scroll)
        .take(spaces.height.saturating_sub(2) as usize)
        .enumerate()
    {
        hits.push((
            Rect::new(spaces.x, spaces.y + 2 + i as u16, spaces.width, 1),
            row.action.clone(),
        ));
    }
    for (i, agent) in app
        .snapshot
        .agents
        .iter()
        .skip(app.agents_scroll)
        .take(agents.height.saturating_sub(2).div_ceil(7) as usize)
        .enumerate()
    {
        let y = agents.y + 2 + (i * 7) as u16;
        hits.push((
            Rect::new(
                agents.x,
                y,
                agents.width,
                7.min(agents.bottom().saturating_sub(y)),
            ),
            Action::Select(agent.target.clone()),
        ));
    }
    let tabs = app.tabs();
    let labels: Vec<_> = tabs.iter().map(|t| tab_label(t, app.tick)).collect();
    let active = tabs
        .iter()
        .position(|t| Some(&t.target) == app.active.as_ref())
        .unwrap_or(0);
    let tab_rects = layout_tabs(
        &labels,
        Rect::new(
            tab_area.x + 3,
            tab_area.y,
            tab_area.width.saturating_sub(9),
            tab_area.height,
        ),
        active,
    );
    for (tab, rect) in tabs.iter().zip(&tab_rects) {
        if rect.width > 0 {
            hits.push((*rect, Action::Select(tab.target.clone())));
        }
    }
    if tab_area.width >= 9 {
        hits.push((Rect::new(tab_area.x, tab_area.y, 3, 1), Action::TabStep(-1)));
        hits.push((
            Rect::new(tab_area.right() - 6, tab_area.y, 3, 1),
            Action::TabStep(1),
        ));
        hits.push((
            Rect::new(tab_area.right() - 3, tab_area.y, 3, 1),
            Action::New(false),
        ));
    }
    hits.push((
        Rect::new(
            right.x + 1,
            right.y + 1,
            8,
            right.height.saturating_sub(1).min(1),
        ),
        Action::Surface(Surface::Chat),
    ));
    hits.push((
        Rect::new(
            right.x + 10,
            right.y + 1,
            12,
            right.height.saturating_sub(1).min(1),
        ),
        Action::Surface(Surface::Terminal),
    ));
    View {
        sidebar,
        spaces,
        agents,
        tab_area,
        content: Rect::new(
            right.x,
            right.y + 2,
            right.width,
            right.height.saturating_sub(2),
        ),
        footer: Rect::new(
            area.x,
            area.bottom().saturating_sub(1),
            area.width,
            1.min(area.height),
        ),
        nav,
        tab_rects,
        hits,
    }
}
fn text(frame: &mut Frame, area: Rect, value: impl Into<String>, color: Color, bg: Color) {
    if area.width > 0 && area.height > 0 {
        frame.render_widget(
            Paragraph::new(value.into()).style(Style::default().fg(color).bg(bg)),
            area,
        );
    }
}
pub fn render(app: &App, view: &View, frame: &mut Frame) {
    frame.render_widget(
        Block::default().style(Style::default().bg(BG).fg(TEXT)),
        frame.area(),
    );
    if view.sidebar.width > 0 {
        frame.render_widget(
            Block::default().style(Style::default().bg(PANEL)),
            view.sidebar,
        );
        text(
            frame,
            Rect::new(
                view.spaces.x + 1,
                view.spaces.y,
                view.spaces.width.saturating_sub(2),
                1,
            ),
            "Hati  /  machines",
            ACCENT,
            PANEL,
        );
        for (i, row) in view
            .nav
            .iter()
            .skip(app.spaces_scroll)
            .take(view.spaces.height.saturating_sub(2) as usize)
            .enumerate()
        {
            let focused = app.focus == Focus::Spaces && app.nav_index == i + app.spaces_scroll;
            text(
                frame,
                Rect::new(
                    view.spaces.x + 1,
                    view.spaces.y + 2 + i as u16,
                    view.spaces.width.saturating_sub(2),
                    1,
                ),
                middle_elide(&row.text, view.spaces.width.saturating_sub(2) as usize),
                if row.machine { ACCENT } else { TEXT },
                if row.selected || focused {
                    SURFACE
                } else {
                    PANEL
                },
            );
        }
        let filter = &app.snapshot.preferences.filter;
        text(
            frame,
            Rect::new(
                view.agents.x + 1,
                view.agents.y,
                view.agents.width.saturating_sub(2),
                1,
            ),
            format!(
                "agents  {} · {}",
                if filter.is_empty() { "all" } else { filter },
                if app.snapshot.preferences.by_priority {
                    "priority"
                } else {
                    "recent"
                }
            ),
            MUTED,
            PANEL,
        );
        for (i, agent) in app
            .snapshot
            .agents
            .iter()
            .skip(app.agents_scroll)
            .enumerate()
        {
            let y = view.agents.y + 2 + (i * 7) as u16;
            if y >= view.agents.bottom() {
                break;
            }
            let rows = [
                format!(
                    "{} {} · {}",
                    glyph(agent, app.tick),
                    agent.space_name,
                    agent.name
                ),
                format!("  {}", agent.host_name),
                format!("  {}", agent.status),
                format!("  {}", agent.runtime),
            ];
            let selected = app.active.as_ref() == Some(&agent.target)
                || app.focus == Focus::Agents && app.agent_index == app.agents_scroll + i;
            for (j, row) in rows.iter().enumerate() {
                if y + j as u16 >= view.agents.bottom() {
                    break;
                }
                text(
                    frame,
                    Rect::new(
                        view.agents.x + 1,
                        y + j as u16,
                        view.agents.width.saturating_sub(2),
                        1,
                    ),
                    truncate_end(row, view.agents.width.saturating_sub(2) as usize),
                    if j == 2 {
                        state_color(agent)
                    } else if j == 0 {
                        TEXT
                    } else {
                        MUTED
                    },
                    if selected { SURFACE } else { PANEL },
                );
            }
            if y + 4 < view.agents.bottom() {
                frame.render_widget(
                    Paragraph::new(agent.query.clone())
                        .wrap(Wrap { trim: false })
                        .style(Style::default().fg(TEXT).bg(if selected {
                            SURFACE
                        } else {
                            PANEL
                        })),
                    Rect::new(
                        view.agents.x + 3,
                        y + 4,
                        view.agents.width.saturating_sub(4),
                        3.min(view.agents.bottom() - (y + 4)),
                    ),
                );
            }
        }
    }
    let tabs = app.tabs();
    text(
        frame,
        view.tab_area,
        " ".repeat(view.tab_area.width as usize),
        TEXT,
        PANEL,
    );
    for (tab, rect) in tabs.iter().zip(&view.tab_rects) {
        let active = app.active.as_ref() == Some(&tab.target);
        text(
            frame,
            *rect,
            format!(
                " {}",
                truncate_end(
                    &tab_label(tab, app.tick),
                    rect.width.saturating_sub(2) as usize
                )
            ),
            if active { TEXT } else { state_color(tab) },
            if active { SURFACE } else { PANEL },
        );
    }
    if view.tab_area.width >= 9 {
        text(
            frame,
            Rect::new(view.tab_area.x, view.tab_area.y, 3, 1),
            " ‹ ",
            MUTED,
            PANEL,
        );
        text(
            frame,
            Rect::new(view.tab_area.right() - 6, view.tab_area.y, 6, 1),
            " ›  + ",
            ACCENT,
            PANEL,
        );
    }
    let mode = if app.surface == Surface::Chat {
        "[Chat]   Terminal"
    } else {
        " Chat   [Terminal]"
    };
    text(
        frame,
        Rect::new(
            view.content.x + 1,
            view.content.y.saturating_sub(1),
            view.content.width.saturating_sub(1),
            1,
        ),
        format!(
            "{}   {}",
            mode,
            app.tab()
                .map(|t| format!("{} / {}  {}", t.host_name, t.space_name, t.status))
                .unwrap_or_default()
        ),
        MUTED,
        BG,
    );
    if app.active.is_none() {
        let errors = app
            .snapshot
            .machines
            .iter()
            .filter(|m| !m.error.is_empty())
            .map(|m| format!("{}: {}", m.name, m.error))
            .collect::<Vec<_>>()
            .join("\n");
        frame.render_widget(Paragraph::new(format!("\nhati\n\nマシン → Space → Tab\n\nCtrl+B c  新しいCodex\nCtrl+B s  新しいシェル\nCtrl+B ?  操作一覧\n\n接続先の追加:\nhati machine add work user@host\n\n{errors}")).wrap(Wrap{trim:false}).style(Style::default().fg(TEXT)),view.content);
    } else if app.surface == Surface::Terminal {
        if let Some(terminal) = &app.terminal {
            frame.render_widget(TerminalView(terminal.parser.screen()), view.content);
            let (row, col) = terminal.parser.screen().cursor_position();
            if app.focus == Focus::Content
                && !terminal.parser.screen().hide_cursor()
                && row < view.content.height
                && col < view.content.width
            {
                frame.set_cursor_position((view.content.x + col, view.content.y + row));
            }
        } else {
            text(
                frame,
                view.content,
                "\nターミナルへ接続しています。Ctrl+B h で会話を表示",
                MUTED,
                BG,
            );
        }
    } else {
        render_chat(app, view.content, frame);
    }
    let footer = if app.prefix {
        "Ctrl+B  q:終了 w:Spaces a:Agents n/p:タブ c:新規 t:端末 h:会話 x:閉じる r:同期 ?:ヘルプ"
            .to_string()
    } else if !app.message.is_empty() {
        app.message.clone()
    } else {
        format!(
            " Ctrl+B ? 操作   Ctrl+B w/a 選択   Ctrl+S 送信   未確認の操作: {}",
            app.snapshot.pending.len()
        )
    };
    text(
        frame,
        view.footer,
        truncate_end(&footer, view.footer.width as usize),
        if app.message.is_empty() {
            MUTED
        } else {
            Color::Rgb(243, 139, 168)
        },
        PANEL,
    );
    if app.help {
        overlay(frame,"Hati · Herdr keys", "Ctrl+B の後にキーを押します\n\n w / a  Spaces / Agentsを選択（↑↓・Enter）\n n / p  次 / 前のタブ\n c / s  新しいCodex / シェル\n N      別のディレクトリでSpaceを作成\n x      共有タブを閉じる（ジョブは継続）\n o      同じ会話の端末を再開\n t / h  ターミナル / チャット\n r      同期・未確認の送信結果を確認\n f / P  Agentsの状態フィルター / 優先度順\n H      アーカイブを含める\n y      確認待ちの操作へ回答\n q      CLIを終了（リモートの作業は継続）\n\nチャット: Enterで改行 / Ctrl+Sで送信\nPageUp/Down・ホイールで履歴をスクロール\nターミナル: Ctrl+B Ctrl+Bでprefix自体を送信\n\nEsc で閉じる",None);
    }
    if let Some(modal) = &app.modal {
        render_modal(frame, modal);
    }
}
fn render_modal(frame: &mut Frame, modal: &crate::app::Modal) {
    let screen = frame.area();
    let width = screen.width.saturating_sub(4).min(90);
    let height = screen.height.saturating_sub(4).min(30);
    let area = Rect::new(
        (screen.width - width) / 2,
        (screen.height - height) / 2,
        width,
        height,
    );
    frame.render_widget(Clear, area);
    let block = Block::default()
        .borders(Borders::ALL)
        .title(modal.title.clone())
        .style(Style::default().bg(PANEL).fg(TEXT));
    let inner = block.inner(area);
    frame.render_widget(block, area);
    let prompt_area = Rect::new(
        inner.x,
        inner.y,
        inner.width,
        inner.height.saturating_sub(5),
    );
    let prompt = Paragraph::new(modal.prompt.clone()).wrap(Wrap { trim: false });
    let last = (prompt.line_count(inner.width.max(1)).min(u16::MAX as usize) as u16)
        .saturating_sub(prompt_area.height);
    frame.render_widget(prompt.scroll((modal.scroll.min(last), 0)), prompt_area);
    let input_area = Rect::new(
        inner.x,
        inner.bottom().saturating_sub(4).max(inner.y),
        inner.width,
        3.min(inner.height),
    );
    let input = Paragraph::new(format!("> {}", modal.text))
        .wrap(Wrap { trim: false })
        .style(Style::default().fg(ACCENT));
    let offset = (input
        .line_count(input_area.width.max(1))
        .min(u16::MAX as usize) as u16)
        .saturating_sub(input_area.height);
    frame.render_widget(input.scroll((offset, 0)), input_area);
    text(
        frame,
        Rect::new(
            inner.x,
            inner.bottom().saturating_sub(1),
            inner.width,
            1.min(inner.height),
        ),
        "Enter 実行 · Esc 戻る · PageUp/Down 内容をスクロール",
        MUTED,
        PANEL,
    );
}
fn render_chat(app: &App, area: Rect, frame: &mut Frame) {
    let composer_h = 5.min(area.height);
    let history = Rect::new(
        area.x + 1,
        area.y,
        area.width.saturating_sub(2),
        area.height.saturating_sub(composer_h),
    );
    let mut lines = Vec::new();
    if let Some(detail) = &app.snapshot.detail {
        if app.snapshot.selected.as_ref() == app.active.as_ref() {
            if let Some(error) = detail["error"].as_str() {
                lines.push(Line::styled(error.to_owned(), Style::default().fg(MUTED)));
            }
            if let Some(items) = detail["items"].as_array() {
                for item in items {
                    let kind = item["kind"].as_str().unwrap_or("activity");
                    let label = match kind {
                        "userMessage" => "you",
                        "agentMessage" => "codex",
                        "commandExecution" => "コマンド実行",
                        "fileChange" => "ファイル変更",
                        "reasoning" => "考えています",
                        "plan" => "計画",
                        "webSearch" => "検索",
                        "mcpToolCall" | "dynamicToolCall" => "ツール実行",
                        "collabAgentToolCall" => "エージェント",
                        "contextCompaction" => "コンテキスト整理",
                        _ => "作業記録",
                    };
                    lines.push(Line::styled(
                        label.to_string(),
                        Style::default()
                            .fg(if kind == "userMessage" { ACCENT } else { MUTED })
                            .add_modifier(Modifier::BOLD),
                    ));
                    let text = item["text"]
                        .as_str()
                        .filter(|s| !s.is_empty())
                        .or_else(|| item["detail"]["command"].as_str())
                        .unwrap_or("");
                    lines.extend(
                        crate::model::safe_text(text)
                            .lines()
                            .map(|s| Line::raw(s.to_string())),
                    );
                    lines.push(Line::raw(""));
                }
            }
            if let Some(preview) = detail["preview"].as_str() {
                lines.extend(preview.lines().map(|s| Line::raw(s.to_string())));
            }
            if detail["approvals"]
                .as_array()
                .is_some_and(|a| !a.is_empty())
            {
                lines.push(Line::styled(
                    "入力待ち · Ctrl+B y で内容を確認して回答",
                    Style::default().fg(Color::Rgb(243, 139, 168)),
                ));
            }
            if let Some(queue) = detail["queuedMessages"].as_array() {
                if !queue.is_empty() {
                    lines.push(Line::raw(format!(
                        "送信キュー: {}件（モバイルと共有）",
                        queue.len()
                    )));
                }
            }
        }
    }
    if lines.is_empty() {
        lines.push(Line::styled(
            app.tab()
                .map(|t| t.latest.clone())
                .filter(|s| !s.is_empty())
                .unwrap_or("指示を入力してください。".into()),
            Style::default().fg(MUTED),
        ));
    }
    let paragraph = Paragraph::new(lines)
        .wrap(Wrap { trim: false })
        .style(Style::default().fg(TEXT));
    let total = paragraph
        .line_count(history.width.max(1))
        .min(u16::MAX as usize) as u16;
    let scroll = total
        .saturating_sub(history.height)
        .saturating_sub(app.chat_scroll);
    frame.render_widget(paragraph.scroll((scroll, 0)), history);
    let composer = Rect::new(
        area.x,
        area.bottom().saturating_sub(composer_h),
        area.width,
        composer_h,
    );
    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(Style::default().fg(if app.focus == Focus::Content {
            ACCENT
        } else {
            MUTED
        }))
        .title(if app.sending.is_some() {
            " 送信中… "
        } else {
            " 指示 · Ctrl+S 送信 / Enter 改行 "
        });
    let inner = block.inner(composer);
    frame.render_widget(block, composer);
    let draft = Paragraph::new(app.draft.clone())
        .wrap(Wrap { trim: false })
        .style(Style::default().fg(TEXT));
    let count = draft.line_count(inner.width.max(1)).min(u16::MAX as usize) as u16;
    frame.render_widget(draft.scroll((count.saturating_sub(inner.height), 0)), inner);
}
fn overlay(frame: &mut Frame, title: &str, body: &str, _input: Option<&str>) {
    let screen = frame.area();
    let width = screen.width.saturating_sub(4).min(90);
    let height = screen.height.saturating_sub(4).min(30);
    let area = Rect::new(
        screen.x + (screen.width - width) / 2,
        screen.y + (screen.height - height) / 2,
        width,
        height,
    );
    frame.render_widget(Clear, area);
    frame.render_widget(
        Paragraph::new(body.to_string())
            .wrap(Wrap { trim: false })
            .block(
                Block::default()
                    .borders(Borders::ALL)
                    .title(Span::styled(title.to_string(), Style::default().fg(ACCENT))),
            )
            .style(Style::default().bg(PANEL).fg(TEXT)),
        area,
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn selected_tab_is_visible_with_wide_names_and_narrow_viewport() {
        let labels = vec!["日本語の長いタブ 実行中 1:23".into(); 8];
        let rects = layout_tabs(&labels, Rect::new(40, 0, 25, 1), 7);
        assert!(rects[7].width > 0);
        assert!(rects.iter().all(|r| r.width == 0 || r.right() <= 65));
        assert!(layout_tabs(&labels, Rect::default(), 7)
            .iter()
            .all(|r| r.width == 0));
    }
    #[test]
    fn tab_status_never_turns_stale_completion_into_live_success() {
        let t = Tab {
            fresh: false,
            name: "1".into(),
            state: "completed".into(),
            status: "最終確認: 応答完了".into(),
            runtime: "実行時間 0:12（最終確認）".into(),
            ..Tab::default()
        };
        assert_eq!(glyph(&t, 1), "?");
        assert!(tab_label(&t, 1).contains("最終確認"));
    }
}
