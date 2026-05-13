//! Frame-aware fast send: type + send a text message directly to a chat's
//! independent X11 window without going through `chat-select` / `send_message`
//! plan. Skips the ~1s `chat-select` + plan overhead when the target chat
//! already has a standalone window open.
//!
//! Steps:
//!   1. Resolve chat display name → X11 window id via `xdotool search --name`.
//!   2. Fetch wechat a11y subtree, locate the input text field's bounds inside
//!      the matching frame.
//!   3. `xdotool windowactivate` the target window.
//!   4. Put text on the clipboard via `xclip`.
//!   5. Click input center → ctrl+v → Return.
//!
//! Acquires the global `PLAN_LOCK` while doing xdotool work so it can't fight
//! a running plan (chat_open / receive_transfer / send_message) for keyboard
//! focus.

use std::process::Stdio;

use tokio::io::AsyncWriteExt;
use tokio::process::Command;

use super::a11y::get_a11y_app;
use super::exec::{exec_command, ExecOptions};
use crate::execution::acquire_plan_lock;
use crate::ia::types::{A11yNode, Bounds};

pub struct FrameSendResult {
    pub ok: bool,
    pub error: Option<String>,
    pub window_id: Option<String>,
    pub input_bounds: Option<Bounds>,
}

fn err(reason: impl Into<String>) -> FrameSendResult {
    FrameSendResult {
        ok: false,
        error: Some(reason.into()),
        window_id: None,
        input_bounds: None,
    }
}

/// Send a plain-text message to a chat by name, using its already-open
/// independent window. Returns an error result if the window can't be
/// found, the input box isn't visible, or any xdotool step fails — caller
/// should fall back to the slow `send_message` plan path.
pub async fn send_to_frame(
    frame_name: &str,
    text: &str,
    options: &ExecOptions,
) -> FrameSendResult {
    if text.is_empty() {
        return err("empty text");
    }
    if frame_name.is_empty() {
        return err("empty frame name");
    }

    // 1. Resolve X11 window id by exact window name match.
    let pattern = format!("^{}$", regex_escape(frame_name));
    let search = exec_command("xdotool", &["search", "--name", &pattern], options).await;
    if search.exit_code != 0 {
        return err(format!("xdotool search failed: {}", search.stderr));
    }
    let wid = match search.stdout.lines().next() {
        Some(s) if !s.trim().is_empty() => s.trim().to_string(),
        _ => return err(format!("no window matching name {frame_name:?}")),
    };

    // 2. Find input bounds in the matching a11y frame.
    let tree = match get_a11y_app("wechat", options).await {
        Ok(t) => t,
        Err(e) => return err(format!("a11y dump failed: {e}")),
    };
    let frame = match find_frame(&tree, frame_name) {
        Some(f) => f,
        None => return err(format!("frame {frame_name:?} not in a11y tree")),
    };
    let input = match find_editable_text(frame) {
        Some(n) => n,
        None => return err(format!("no EDITABLE text in frame {frame_name:?}")),
    };
    let bounds = match input.bounds.clone() {
        Some(b) => b,
        None => return err("input has no bounds"),
    };
    let cx = (bounds.x + bounds.width / 2.0).round() as i32;
    let cy = (bounds.y + bounds.height / 2.0).round() as i32;

    // 3-7. Take the global UI lock for the actual xdotool sequence.
    let _plan_guard = acquire_plan_lock().await;

    if let Err(e) = activate_window(&wid, options).await {
        return err(format!("windowactivate failed: {e}"));
    }
    if let Err(e) = set_clipboard(text).await {
        return err(format!("xclip failed: {e}"));
    }

    // Focus input, paste, send. Wait between steps so the UI keeps up.
    //
    // NOTE: do NOT pass `--sync` to mousemove. xdotool's --sync waits for an
    // X motion event; if the pointer is already at the target coords (e.g.
    // sending a second message to the same chat in a row, with the cursor
    // still parked on the input box), no motion event ever fires and the
    // command hangs for its internal timeout (~16s) before we hit our own
    // exec timeout. `windowactivate --sync` above already guarantees focus.
    let click_args = [
        "mousemove",
        &cx.to_string(),
        &cy.to_string(),
        "click",
        "1",
    ];
    let r = exec_command("xdotool", &click_args, options).await;
    if r.exit_code != 0 {
        return err(format!("xdotool focus click failed: {}", r.stderr));
    }

    // Small delay so the click finishes registering before paste keystroke
    tokio::time::sleep(std::time::Duration::from_millis(40)).await;

    let r = exec_command("xdotool", &["key", "--clearmodifiers", "ctrl+v"], options).await;
    if r.exit_code != 0 {
        return err(format!("xdotool paste failed: {}", r.stderr));
    }

    tokio::time::sleep(std::time::Duration::from_millis(60)).await;

    let r = exec_command("xdotool", &["key", "--clearmodifiers", "Return"], options).await;
    if r.exit_code != 0 {
        return err(format!("xdotool Return failed: {}", r.stderr));
    }

    FrameSendResult {
        ok: true,
        error: None,
        window_id: Some(wid),
        input_bounds: Some(bounds),
    }
}

async fn activate_window(wid: &str, options: &ExecOptions) -> Result<(), String> {
    let r = exec_command("xdotool", &["windowactivate", "--sync", wid], options).await;
    if r.exit_code != 0 {
        return Err(r.stderr.clone());
    }
    Ok(())
}

async fn set_clipboard(text: &str) -> Result<(), String> {
    // `xclip` blocks until the selection is consumed (typical X11 selection
    // model), so we spawn it detached and let ctrl+v draw the data out.
    let mut child = Command::new("xclip")
        .args(["-selection", "clipboard"])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .env("DISPLAY", std::env::var("DISPLAY").unwrap_or_else(|_| ":99".into()))
        .spawn()
        .map_err(|e| format!("spawn xclip: {e}"))?;
    if let Some(stdin) = child.stdin.as_mut() {
        stdin
            .write_all(text.as_bytes())
            .await
            .map_err(|e| format!("write to xclip stdin: {e}"))?;
    }
    drop(child.stdin.take()); // close stdin → xclip can now serve paste requests
    // Give xclip a moment to register the selection
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    Ok(())
}

fn regex_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '.' | '*' | '+' | '?' | '|' | '(' | ')' | '[' | ']' | '{' | '}' | '^' | '$' | '\\' => {
                out.push('\\');
                out.push(c);
            }
            _ => out.push(c),
        }
    }
    out
}

fn find_frame<'a>(root: &'a A11yNode, name: &str) -> Option<&'a A11yNode> {
    if root.role == "frame" && root.name == name {
        return Some(root);
    }
    if let Some(children) = &root.children {
        for c in children {
            if let Some(f) = find_frame(c, name) {
                return Some(f);
            }
        }
    }
    None
}

fn find_editable_text<'a>(node: &'a A11yNode) -> Option<&'a A11yNode> {
    if node.role == "text"
        && node
            .states
            .as_ref()
            .map(|s| s.iter().any(|st| st == "EDITABLE"))
            .unwrap_or(false)
    {
        return Some(node);
    }
    if let Some(children) = &node.children {
        for c in children {
            if let Some(found) = find_editable_text(c) {
                return Some(found);
            }
        }
    }
    None
}
