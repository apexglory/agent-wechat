//! Long-running a11y dump daemon client.
//!
//! Spawns `/opt/tools/a11y-dumpd` as a child process the first time a dump
//! is requested, then reuses it for subsequent calls. Eliminates the
//! ~500-900ms Python startup + Atspi.init() overhead per dump.
//!
//! Protocol: line-based. Each request is one line on stdin
//! (`dump [--app NAME] [--max-depth N]`), each response is one line of
//! JSON on stdout.
//!
//! Failure handling: if a request errors (process died, broken pipe, etc.)
//! the handle is cleared so the next call re-spawns. Callers can fall back
//! to one-shot exec_command in `a11y.rs` if the daemon is unavailable.

use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::{Mutex, OnceCell};
use tokio::time::timeout;

use super::exec::ExecOptions;
use crate::ia::types::Session;

const A11Y_DAEMON_PATH: &str = "/opt/tools/a11y-dumpd";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);

struct DaemonHandle {
    // Held so the child isn't reaped on drop; we don't await on it.
    _child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
}

impl DaemonHandle {
    async fn spawn(session: Option<&Session>) -> Result<Self, String> {
        let mut cmd = Command::new("python3");
        cmd.arg(A11Y_DAEMON_PATH)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .env("QT_ACCESSIBILITY", "1")
            .env("QT_LINUX_ACCESSIBILITY_ALWAYS_ON", "1");

        if let Some(s) = session {
            cmd.env("DISPLAY", &s.display);
            if let Some(addr) = &s.dbus_address {
                cmd.env("DBUS_SESSION_BUS_ADDRESS", addr);
            }
            cmd.env("HOME", format!("/home/{}", s.linux_user));
        } else {
            // Match ExecOptions::default() behaviour
            if std::env::var("DISPLAY").is_err() {
                cmd.env("DISPLAY", ":99");
            }
        }

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("spawn a11y daemon: {e}"))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "no stdin from a11y daemon".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "no stdout from a11y daemon".to_string())?;
        Ok(DaemonHandle {
            _child: child,
            stdin,
            stdout: BufReader::new(stdout),
        })
    }

    async fn request(&mut self, cmd: &str) -> Result<String, String> {
        self.stdin
            .write_all(cmd.as_bytes())
            .await
            .map_err(|e| format!("write cmd: {e}"))?;
        self.stdin
            .write_all(b"\n")
            .await
            .map_err(|e| format!("write newline: {e}"))?;
        self.stdin
            .flush()
            .await
            .map_err(|e| format!("flush stdin: {e}"))?;

        let mut line = String::new();
        let n = timeout(REQUEST_TIMEOUT, self.stdout.read_line(&mut line))
            .await
            .map_err(|_| "a11y daemon read timed out".to_string())?
            .map_err(|e| format!("read stdout: {e}"))?;
        if n == 0 {
            return Err("a11y daemon closed stdout".to_string());
        }
        // Trim trailing newline; keep inner content as-is.
        let len = line.trim_end_matches(['\n', '\r']).len();
        line.truncate(len);
        Ok(line)
    }
}

static DAEMON: OnceCell<Arc<Mutex<Option<DaemonHandle>>>> = OnceCell::const_new();

async fn handle_slot() -> Arc<Mutex<Option<DaemonHandle>>> {
    DAEMON
        .get_or_init(|| async { Arc::new(Mutex::new(None)) })
        .await
        .clone()
}

/// Request a dump from the daemon. Spawns the daemon on first call and
/// respawns it if a request fails (broken pipe, killed child, etc.).
///
/// Returns the raw single-line JSON response string. Callers parse it
/// the same way they parse the one-shot `a11y-dump` output.
pub async fn dump_via_daemon(
    app: Option<&str>,
    max_depth: i32,
    options: &ExecOptions,
) -> Result<String, String> {
    let mut cmd = String::from("dump");
    if let Some(a) = app {
        cmd.push_str(" --app ");
        cmd.push_str(a);
    }
    if max_depth != 30 {
        cmd.push_str(" --max-depth ");
        cmd.push_str(&max_depth.to_string());
    }

    let slot = handle_slot().await;
    let mut guard = slot.lock().await;

    if guard.is_none() {
        match DaemonHandle::spawn(options.session.as_ref()).await {
            Ok(h) => *guard = Some(h),
            Err(e) => return Err(format!("a11y daemon spawn failed: {e}")),
        }
    }

    let result = {
        let handle = guard.as_mut().expect("just initialized");
        handle.request(&cmd).await
    };

    match result {
        Ok(line) => Ok(line),
        Err(e) => {
            // Tear down so the next caller respawns.
            *guard = None;
            Err(format!("a11y daemon request failed (will respawn): {e}"))
        }
    }
}
