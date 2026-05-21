//! Global UI mutex serializing all routes that mutate the WeChat client UI.
//!
//! The WeChat process is a single GUI app driven by xdotool / Atspi from
//! multiple HTTP routes (send_message, receive_transfer, receive_red_packet,
//! open_chat, login, logout, and the a11y_state autoOpen path). Each of
//! those holds its own plan FSM that interleaves clicks, key events, and
//! a11y reads across several seconds; running two of them concurrently lets
//! one route's click steal focus from the other, dropping the FSM into
//! "No action selected" (the send loses its input field focus, the send
//! button never re-enables, the plan returns None).
//!
//! Observed on qiafan-bot 2026-05-21 15:42–15:50: brandsessionholder's hot
//! catch-up loop was firing wechatA11yState({autoOpen:true}) at ~1 Hz,
//! whose xdotool click landed mid-SendMessagePlan from qiafan2-mcp and
//! killed 14 outbound replies in 8 minutes.
//!
//! Hold the guard returned by `lock()` for the entire UI-mutating critical
//! section. Read-only routes (list_messages, list_chats, get_media,
//! a11y_state without autoOpen, screenshot, auth_status) do NOT need this —
//! they only read WCDB or the a11y tree and can run concurrently.

use std::sync::OnceLock;
use tokio::sync::{Mutex, MutexGuard};

static UI_MUTEX: OnceLock<Mutex<()>> = OnceLock::new();

fn mutex() -> &'static Mutex<()> {
    UI_MUTEX.get_or_init(|| Mutex::new(()))
}

/// Acquire the global UI mutex. Holds until the returned guard is dropped.
pub async fn lock() -> MutexGuard<'static, ()> {
    mutex().lock().await
}
