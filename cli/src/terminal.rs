use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use ratatui::{
    buffer::Buffer,
    layout::Rect,
    style::{Color, Modifier, Style},
    widgets::Widget,
};
use serde::Deserialize;
use std::{
    io::{Read, Write},
    sync::mpsc,
    thread,
};

#[derive(Deserialize)]
pub struct TerminalCommand {
    pub file: String,
    pub args: Vec<String>,
}
pub struct Terminal {
    master: Box<dyn MasterPty + Send>,
    child: Box<dyn Child + Send + Sync>,
    writer: Box<dyn Write + Send>,
    output: mpsc::Receiver<Vec<u8>>,
    pub parser: vt100::Parser,
    size: (u16, u16),
    pub ended: bool,
}
impl Terminal {
    pub fn start(
        command: TerminalCommand,
        rows: u16,
        cols: u16,
    ) -> Result<Self, Box<dyn std::error::Error>> {
        let pair = native_pty_system().openpty(PtySize {
            rows: rows.max(1),
            cols: cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        })?;
        let mut cmd = CommandBuilder::new(command.file);
        cmd.args(command.args);
        cmd.env("TERM", "xterm-256color");
        cmd.env("TMUX", "");
        cmd.env("TMUX_PANE", "");
        let child = pair.slave.spawn_command(cmd)?;
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader()?;
        let writer = pair.master.take_writer()?;
        let (tx, output) = mpsc::sync_channel(128);
        thread::spawn(move || {
            let mut buffer = [0u8; 16384];
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if tx.send(buffer[..n].to_vec()).is_err() {
                            break;
                        }
                    }
                }
            }
        });
        Ok(Self {
            master: pair.master,
            child,
            writer,
            output,
            parser: vt100::Parser::new(rows.max(1), cols.max(1), 10000),
            size: (rows, cols),
            ended: false,
        })
    }
    pub fn poll(&mut self) {
        for data in self.output.try_iter().take(128) {
            self.parser.process(&data);
        }
        self.ended = self.child.try_wait().ok().flatten().is_some();
    }
    pub fn resize(&mut self, rows: u16, cols: u16) {
        let size = (rows.max(1), cols.max(1));
        if size != self.size {
            let _ = self.master.resize(PtySize {
                rows: size.0,
                cols: size.1,
                pixel_width: 0,
                pixel_height: 0,
            });
            self.parser.screen_mut().set_size(size.0, size.1);
            self.size = size;
        }
    }
    pub fn write(&mut self, bytes: &[u8]) {
        self.parser.screen_mut().set_scrollback(0);
        let _ = self.writer.write_all(bytes);
        let _ = self.writer.flush();
    }
    pub fn scroll(&mut self, delta: i32) {
        let offset = self.parser.screen().scrollback();
        self.parser
            .screen_mut()
            .set_scrollback(offset.saturating_add_signed(delta as isize));
    }
}
impl Drop for Terminal {
    fn drop(&mut self) {
        // This child is a tmux/SSH attachment, never the job inside the daemon's pane.
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
pub struct TerminalView<'a>(pub &'a vt100::Screen);
fn color(c: vt100::Color) -> Color {
    match c {
        vt100::Color::Default => Color::Reset,
        vt100::Color::Idx(i) => Color::Indexed(i),
        vt100::Color::Rgb(r, g, b) => Color::Rgb(r, g, b),
    }
}
impl Widget for TerminalView<'_> {
    fn render(self, area: Rect, buffer: &mut Buffer) {
        for row in 0..area.height {
            for col in 0..area.width {
                let Some(cell) = self.0.cell(row, col) else {
                    continue;
                };
                if cell.is_wide_continuation() {
                    continue;
                }
                let mut style = Style::default()
                    .fg(color(cell.fgcolor()))
                    .bg(color(cell.bgcolor()));
                if cell.bold() {
                    style = style.add_modifier(Modifier::BOLD);
                }
                if cell.italic() {
                    style = style.add_modifier(Modifier::ITALIC);
                }
                if cell.underline() {
                    style = style.add_modifier(Modifier::UNDERLINED);
                }
                if cell.inverse() {
                    style = style.add_modifier(Modifier::REVERSED);
                }
                let contents = cell.contents();
                buffer.set_stringn(
                    area.x + col,
                    area.y + row,
                    if contents.is_empty() { " " } else { &contents },
                    (area.width - col) as usize,
                    style,
                );
            }
        }
    }
}
