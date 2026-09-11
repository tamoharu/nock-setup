use serde_json::{json, Value};
use std::{
    io::{BufRead, BufReader, Write},
    process::{Child, ChildStdin, Command, Stdio},
    sync::mpsc,
    thread,
    time::Duration,
};

pub struct Backend {
    child: Child,
    input: Option<ChildStdin>,
    pub events: mpsc::Receiver<Value>,
    sequence: u64,
}
impl Backend {
    pub fn start(node: &str, script: &str, state: &str) -> std::io::Result<Self> {
        let mut child = Command::new(node)
            .args(["--no-warnings", script, state])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()?;
        let input = child.stdin.take();
        let output = child
            .stdout
            .take()
            .ok_or_else(|| std::io::Error::other("backend stdout"))?;
        let error = child
            .stderr
            .take()
            .ok_or_else(|| std::io::Error::other("backend stderr"))?;
        let (tx, events) = mpsc::channel();
        let errors = tx.clone();
        thread::spawn(move || {
            for line in BufReader::new(output).lines().map_while(Result::ok) {
                if let Ok(value) = serde_json::from_str(&line) {
                    if tx.send(value).is_err() {
                        return;
                    }
                }
            }
            let _ = tx.send(json!({"type":"disconnected", "error":"接続処理が終了しました。CLIを起動し直してください。"}));
        });
        thread::spawn(move || {
            for line in BufReader::new(error).lines().map_while(Result::ok) {
                let _ = errors.send(json!({"type":"error", "error":line}));
            }
        });
        Ok(Self {
            child,
            input,
            events,
            sequence: 0,
        })
    }
    pub fn send(&mut self, mut value: Value) -> std::io::Result<u64> {
        self.sequence += 1;
        value["id"] = self.sequence.into();
        let input = self
            .input
            .as_mut()
            .ok_or_else(|| std::io::Error::other("backend closed"))?;
        writeln!(input, "{value}")?;
        input.flush()?;
        Ok(self.sequence)
    }
}
impl Drop for Backend {
    fn drop(&mut self) {
        // EOF lets Node close only its SSH tunnels. Never stop the daemon.
        drop(self.input.take());
        for _ in 0..20 {
            if self.child.try_wait().ok().flatten().is_some() {
                return;
            }
            thread::sleep(Duration::from_millis(50));
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
