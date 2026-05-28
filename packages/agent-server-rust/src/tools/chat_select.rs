use super::exec::{exec_command, ExecOptions};
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OpenChatResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub index: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skipped: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// Captured Frida script output on enumerate failure — lets the caller
    /// log exactly which stage of the session-enum dance broke (manager
    /// scan vs vector pointers vs validation).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub frida_diag: Option<Vec<String>>,
}

/// Minimum gap between automatic wechat kills triggered by "No sessions found"
/// recovery. WeChat takes a few seconds to fully respawn + log back in via the
/// LoginAccount auto-click, so we want at least 60 s before considering another
/// kill — otherwise a stuck chat-select would crash-loop the client.
const KILL_COOLDOWN_SECS: u64 = 60;

/// Last unix-epoch second we triggered a recovery kill. 0 means never.
static LAST_RECOVERY_KILL_UNIX: AtomicU64 = AtomicU64::new(0);

fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// True if "No sessions found" coming back from chat-select means Frida's
/// session-vector enumeration is broken (typically: the manager landed in a
/// memory chunk we somehow missed, or wechat is in a wedged half-init state).
/// In production this state only clears when wechat restarts — the heap layout
/// resets and the manager becomes findable again.
fn is_session_enum_wedge(err: &str) -> bool {
    err.contains("No sessions found")
}

/// Best-effort: kill all wechat main processes so the health monitor respawns
/// them. Returns whether a kill was actually issued (respecting the cooldown).
///
/// Uses `pkill -9 -x wechat` so we only nail the top-level `/usr/bin/wechat`
/// processes, not the `WeChatAppEx` / `crashpad_handler` siblings (they'll be
/// taken down by their parent).
fn pkill_wechat_if_cooldown_ok() -> bool {
    let last = LAST_RECOVERY_KILL_UNIX.load(Ordering::Relaxed);
    let now = now_unix();
    if last != 0 && now.saturating_sub(last) < KILL_COOLDOWN_SECS {
        tracing::warn!(
            "[open_chat] suppressing recovery kill: last kill {}s ago < cooldown {}s",
            now.saturating_sub(last),
            KILL_COOLDOWN_SECS
        );
        return false;
    }
    LAST_RECOVERY_KILL_UNIX.store(now, Ordering::Relaxed);

    let out = std::process::Command::new("pkill")
        .args(["-9", "-x", "wechat"])
        .output();
    match out {
        Ok(o) if o.status.success() => {
            tracing::warn!("[open_chat] recovery: killed wechat process(es) to clear wedged session-enum state — health_monitor will respawn + auto-login");
            true
        }
        Ok(o) => {
            // pkill exits 1 when no process matched — not a real failure but
            // means we couldn't recover. Health monitor will pick up the gap.
            tracing::warn!(
                "[open_chat] recovery pkill returned {}: {}",
                o.status.code().unwrap_or(-1),
                String::from_utf8_lossy(&o.stderr).trim()
            );
            false
        }
        Err(e) => {
            tracing::error!("[open_chat] recovery pkill failed: {}", e);
            false
        }
    }
}

/// Open a chat in the WeChat UI using the chat-select tool.
///
/// Args format: chat-select [--force] [--click-xy X Y] <username>
///
/// On a "No sessions found" failure (Frida enumerate wedge) this also kicks
/// off a recovery kill: the wechat process is pkill'd so health_monitor
/// respawns it, the LoginAccount auto-click then resumes the session, and
/// the next open_chat call typically succeeds. The current call still
/// returns ok=false — the caller's existing retry loop is what actually
/// drives recovery.
pub async fn open_chat(chat_id: &str, force: bool, click_xy: Option<(f64, f64)>) -> OpenChatResult {
    let mut args: Vec<String> = Vec::new();

    if force {
        args.push("--force".into());
    }

    if let Some((x, y)) = click_xy {
        args.push("--click-xy".into());
        args.push((x as i32).to_string());
        args.push((y as i32).to_string());
    }

    // chat_id is a positional arg — must be last
    args.push(chat_id.into());

    let args_ref: Vec<&str> = args.iter().map(|s| s.as_str()).collect();

    let result = exec_command("chat-select", &args_ref, &ExecOptions::default()).await;

    // Result JSON is on stdout regardless of exit code
    let parsed = if let Ok(parsed) = serde_json::from_str::<OpenChatResult>(&result.stdout) {
        parsed
    } else {
        // Fallback: couldn't parse stdout
        OpenChatResult {
            ok: false,
            username: None,
            index: None,
            skipped: None,
            error: Some(if result.stderr.is_empty() {
                format!("chat-select exited with code {}", result.exit_code)
            } else {
                result.stderr
            }),
            frida_diag: None,
        }
    };

    if !parsed.ok {
        if let Some(err) = parsed.error.as_deref() {
            if is_session_enum_wedge(err) {
                pkill_wechat_if_cooldown_ok();
            }
        }
    }

    parsed
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn is_session_enum_wedge_matches() {
        assert!(is_session_enum_wedge(
            "No sessions found. Is WeChat logged in with chats visible?"
        ));
        assert!(!is_session_enum_wedge("'wxid_xxx' not found in session list"));
        assert!(!is_session_enum_wedge("WeChat is not running"));
        assert!(!is_session_enum_wedge("chat-select exited with code 1"));
    }
}
