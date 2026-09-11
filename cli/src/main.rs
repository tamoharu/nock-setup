mod app;
mod backend;
mod chrome;
mod input;
mod model;
mod terminal;
mod text;

use app::{Action, App, Focus, Surface};
use backend::Backend;
use crossterm::{
    event::{
        self, DisableBracketedPaste, DisableMouseCapture, EnableBracketedPaste, EnableMouseCapture,
        Event, KeyCode, KeyEvent, KeyEventKind, KeyModifiers, MouseButton, MouseEventKind,
    },
    execute,
    terminal::{disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen},
};
use ratatui::{backend::CrosstermBackend, layout::Position, Terminal};
use serde_json::json;
use std::{
    io::{self, IsTerminal},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};

struct ScreenGuard;
impl Drop for ScreenGuard {
    fn drop(&mut self) {
        let _ = disable_raw_mode();
        let _ = execute!(
            io::stdout(),
            LeaveAlternateScreen,
            DisableMouseCapture,
            DisableBracketedPaste,
            crossterm::cursor::Show
        );
    }
}
fn main() {
    if let Err(error) = run() {
        eprintln!("hati: {error}");
        std::process::exit(1);
    }
}
fn run() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args().collect();
    if args.iter().any(|v| v == "--help" || v == "-h") || args.len() == 1 {
        println!("hati-tui {}\n\nhati tui で起動します。\nCtrl+B ? 操作一覧 / Ctrl+B q 終了\n\nHerdr v0.7.5から派生したhatiクライアント（AGPL-3.0-or-later）。",env!("CARGO_PKG_VERSION"));
        return Ok(());
    }
    if args.iter().any(|v| v == "--version") {
        println!("hati-tui {}", env!("CARGO_PKG_VERSION"));
        return Ok(());
    }
    let option = |name: &str| {
        args.iter()
            .position(|v| v == name)
            .and_then(|i| args.get(i + 1))
            .map(String::as_str)
            .ok_or_else(|| format!("missing {name}"))
    };
    if !io::stdin().is_terminal() || !io::stdout().is_terminal() {
        return Err("対話ターミナルで起動してください。".into());
    }
    let mut backend = Backend::start(
        option("--backend")?,
        option("--script")?,
        option("--state")?,
    )?;
    let stop = Arc::new(AtomicBool::new(false));
    for signal in [
        signal_hook::consts::SIGTERM,
        signal_hook::consts::SIGHUP,
        signal_hook::consts::SIGINT,
    ] {
        signal_hook::flag::register(signal, stop.clone())?;
    }
    enable_raw_mode()?;
    let _guard = ScreenGuard;
    execute!(
        io::stdout(),
        EnterAlternateScreen,
        EnableMouseCapture,
        EnableBracketedPaste
    )?;
    let mut screen = Terminal::new(CrosstermBackend::new(io::stdout()))?;
    let mut app = App::default();
    while !app.quit && !stop.load(Ordering::Relaxed) {
        let size = screen.size()?;
        let area = ratatui::layout::Rect::new(0, 0, size.width, size.height);
        let view = chrome::compute(&app, area);
        for value in backend.events.try_iter().take(128).collect::<Vec<_>>() {
            app.event(&mut backend, value, view.content.height, view.content.width);
        }
        if let Some(terminal) = &mut app.terminal {
            terminal.resize(view.content.height, view.content.width);
            terminal.poll();
            if terminal.ended {
                app.message = "端末との接続が終了しました。Ctrl+B t で再接続できます。".into();
                app.terminal = None;
            }
        }
        let view = chrome::compute(&app, area);
        screen.draw(|frame| chrome::render(&app, &view, frame))?;
        if event::poll(Duration::from_millis(80))? {
            match event::read()? {
                Event::Key(key) if key.kind != KeyEventKind::Release => {
                    handle_key(&mut app, &mut backend, key)
                }
                Event::Paste(text) => {
                    if let Some(modal) = &mut app.modal {
                        modal.text.push_str(&model::safe_text(&text));
                    } else if app.focus == Focus::Content && app.surface == Surface::Chat {
                        app.draft.push_str(&model::safe_text(&text));
                        app.save_draft(&mut backend);
                    } else if let Some(terminal) = &mut app.terminal {
                        if terminal.parser.screen().bracketed_paste() {
                            terminal.write(b"\x1b[200~");
                            terminal.write(text.as_bytes());
                            terminal.write(b"\x1b[201~");
                        } else {
                            terminal.write(text.as_bytes());
                        }
                    }
                }
                Event::Mouse(mouse) if !app.help && app.modal.is_none() => {
                    let position = Position::new(mouse.column, mouse.row);
                    match mouse.kind {
                        MouseEventKind::Down(MouseButton::Left) => {
                            if let Some((_, action)) =
                                view.hits.iter().find(|(rect, _)| rect.contains(position))
                            {
                                app.act(&mut backend, action.clone());
                            } else if view.content.contains(position) {
                                app.focus = Focus::Content;
                            }
                        }
                        MouseEventKind::ScrollUp | MouseEventKind::ScrollDown => {
                            let delta = if mouse.kind == MouseEventKind::ScrollUp {
                                -1
                            } else {
                                1
                            };
                            if view.agents.contains(position) {
                                app.agents_scroll = app
                                    .agents_scroll
                                    .saturating_add_signed(delta)
                                    .min(app.snapshot.agents.len().saturating_sub(1));
                            } else if view.spaces.contains(position) {
                                app.spaces_scroll = app
                                    .spaces_scroll
                                    .saturating_add_signed(delta)
                                    .min(view.nav.len().saturating_sub(1));
                            } else if app.surface == Surface::Chat {
                                app.chat_scroll =
                                    app.chat_scroll.saturating_add_signed(-delta as i16 * 3);
                            } else if let Some(terminal) = &mut app.terminal {
                                terminal.scroll(-delta as i32 * 3);
                            }
                        }
                        _ => {}
                    }
                }
                _ => {}
            }
        }
        app.tick = app.tick.wrapping_add(1);
    }
    drop(app.terminal.take());
    Ok(())
}
fn handle_key(app: &mut App, backend: &mut Backend, key: KeyEvent) {
    let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
    if app.help {
        app.help = false;
        return;
    }
    if app.modal.is_some() {
        match key.code {
            KeyCode::Esc => app.modal = None,
            KeyCode::Enter => app.finish_modal(backend),
            KeyCode::PageUp => {
                if let Some(modal) = &mut app.modal {
                    modal.scroll = modal.scroll.saturating_sub(8);
                }
            }
            KeyCode::PageDown => {
                if let Some(modal) = &mut app.modal {
                    modal.scroll = modal.scroll.saturating_add(8);
                }
            }
            KeyCode::Backspace => {
                if let Some(modal) = &mut app.modal {
                    modal.text.pop();
                }
            }
            KeyCode::Char('u') if ctrl => {
                if let Some(modal) = &mut app.modal {
                    modal.text.clear();
                }
            }
            KeyCode::Char(c) if !ctrl => {
                if let Some(modal) = &mut app.modal {
                    modal.text.push(c);
                }
            }
            _ => {}
        }
        return;
    }
    if app.prefix {
        app.prefix = false;
        if key.code == KeyCode::Char('b') && ctrl {
            if let Some(terminal) = &mut app.terminal {
                terminal.write(&[2]);
            }
            return;
        }
        match key.code {
            KeyCode::Char('q') => app.quit = true,
            KeyCode::Char('?') => app.help = true,
            KeyCode::Char('w') => app.focus = Focus::Spaces,
            KeyCode::Char('a') => app.focus = Focus::Agents,
            KeyCode::Char('n') => app.act(backend, Action::TabStep(1)),
            KeyCode::Char('p') => app.act(backend, Action::TabStep(-1)),
            KeyCode::Char('c') => app.act(backend, Action::New(false)),
            KeyCode::Char('s') => app.act(backend, Action::New(true)),
            KeyCode::Char('N') => {
                app.space.clear();
                app.act(backend, Action::New(false));
            }
            KeyCode::Char('t') => app.act(backend, Action::Surface(Surface::Terminal)),
            KeyCode::Char('h') => app.act(backend, Action::Surface(Surface::Chat)),
            KeyCode::Char('r') => {
                app.send(backend, json!({"action":"refresh"}));
                app.message = "同期して送信結果を確認しています…".into();
            }
            KeyCode::Char('x') | KeyCode::Char('o') => {
                if let Some(target) = &app.active {
                    app.send(backend,json!({"action":if key.code==KeyCode::Char('x'){"hide"}else{"resume"},"target":target}));
                }
            }
            KeyCode::Char('y') => app.approval(),
            KeyCode::Char('f') | KeyCode::Char('P') | KeyCode::Char('H') => {
                let mut p = app.snapshot.preferences.clone();
                if p.filter.is_empty() {
                    p.filter = "all".into();
                }
                match key.code {
                    KeyCode::Char('f') => {
                        p.filter = match p.filter.as_str() {
                            "all" => "running",
                            "running" => "waiting",
                            "waiting" => "completed",
                            _ => "all",
                        }
                        .into();
                        app.agents_scroll = 0;
                        app.agent_index = 0;
                    }
                    KeyCode::Char('P') => p.by_priority = !p.by_priority,
                    _ => p.include_archived = !p.include_archived,
                }
                app.send(backend, json!({"action":"preferences","preferences":p}));
            }
            KeyCode::Char(c) if ('1'..='9').contains(&c) => {
                if let Some(target) = app
                    .tabs()
                    .get((c as u8 - b'1') as usize)
                    .map(|t| t.target.clone())
                {
                    app.select(backend, target);
                }
            }
            _ => {}
        }
        return;
    }
    if key.code == KeyCode::Char('b') && ctrl {
        app.prefix = true;
        return;
    }
    if app.focus != Focus::Content {
        let delta = match key.code {
            KeyCode::Up | KeyCode::Char('k') => -1,
            KeyCode::Down | KeyCode::Char('j') => 1,
            _ => 0,
        };
        if app.focus == Focus::Spaces {
            let nav = chrome::navigation(app);
            app.nav_index = app
                .nav_index
                .saturating_add_signed(delta)
                .min(nav.len().saturating_sub(1));
            if app.nav_index < app.spaces_scroll {
                app.spaces_scroll = app.nav_index;
            }
            if app.nav_index >= app.spaces_scroll + 5 {
                app.spaces_scroll = app.nav_index.saturating_sub(4);
            }
            if key.code == KeyCode::Enter {
                if let Some(row) = nav.get(app.nav_index) {
                    app.act(backend, row.action.clone());
                }
            }
        } else {
            app.agent_index = app
                .agent_index
                .saturating_add_signed(delta)
                .min(app.snapshot.agents.len().saturating_sub(1));
            if delta != 0 {
                app.agents_scroll = app.agent_index;
            }
            if key.code == KeyCode::Enter {
                if let Some(target) = app
                    .snapshot
                    .agents
                    .get(app.agent_index)
                    .map(|t| t.target.clone())
                {
                    app.select(backend, target);
                }
            }
        }
        if key.code == KeyCode::Esc {
            app.focus = Focus::Content;
        }
        return;
    }
    if app.surface == Surface::Terminal {
        if let Some(terminal) = &mut app.terminal {
            let bytes = input::encode(key, terminal.parser.screen().application_cursor());
            terminal.write(&bytes);
        }
        return;
    }
    match key.code {
        KeyCode::Char('s') if ctrl => app.submit(backend),
        KeyCode::PageUp => app.chat_scroll = app.chat_scroll.saturating_add(12),
        KeyCode::PageDown => app.chat_scroll = app.chat_scroll.saturating_sub(12),
        KeyCode::Char('u') if ctrl => {
            app.draft.clear();
            app.save_draft(backend);
        }
        KeyCode::Char(c) if !ctrl => {
            app.draft.push(c);
            app.save_draft(backend);
        }
        KeyCode::Backspace => {
            app.draft.pop();
            app.save_draft(backend);
        }
        KeyCode::Enter => {
            app.draft.push('\n');
            app.save_draft(backend);
        }
        _ => {}
    }
}
