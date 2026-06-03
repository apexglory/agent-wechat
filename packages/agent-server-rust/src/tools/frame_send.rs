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
    //
    // Two contacts/groups can legitimately share a display name in WeChat
    // (saw this on 118.196.48.97: two different friends both named the same
    // string). Both popped-out frames carry the same WM_NAME, so xdotool
    // returns multiple window ids and any pick is a 50/50 — observed as
    // messages landing in the wrong chat. Detect that and bail to the slow
    // path, which resolves by chat_id (wxid) via chat_select and is immune
    // to name collisions.
    let pattern = format!("^{}$", regex_escape(frame_name));
    let search = exec_command("xdotool", &["search", "--name", &pattern], options).await;
    if search.exit_code != 0 {
        return err(format!("xdotool search failed: {}", search.stderr));
    }
    let wids: Vec<String> = search
        .stdout
        .lines()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    let wid = match wids.len() {
        0 => return err(format!("no window matching name {frame_name:?}")),
        1 => wids.into_iter().next().unwrap(),
        n => {
            return err(format!(
                "ambiguous window name {frame_name:?}: {n} X11 windows match ({}); falling back to slow path",
                wids.join(",")
            ));
        }
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

    // 3-7. Take the global UI lock for the actual xdotool sequence. Held
    // across the focus restore below so the cleanup also runs serialized.
    let _plan_guard = acquire_plan_lock().await;

    // Snapshot the currently-active X11 window so we can restore focus on
    // every exit path. activate_window below moves X11 focus to the
    // popped-out frame; the slow-path fallback (chat_select /
    // SendMessagePlan) never calls windowactivate itself, so any focus
    // leak from this function causes the slow path's xdotool key events
    // to land in the popped-out frame instead of the main wechat window.
    // Observed downstream as "block reply failed: No action selected"
    // loops that only recover when a human VNC-clicks the main window
    // (qiafan2-bot Server A, 2026-05-25 ~10:40 UTC).
    let prior_active: Option<String> = {
        let r = exec_command("xdotool", &["getactivewindow"], options).await;
        if r.exit_code == 0 {
            let s = r.stdout.trim().to_string();
            (!s.is_empty()).then_some(s)
        } else {
            None
        }
    };
    let wid_for_restore = wid.clone();

    // All focus-touching work runs inside this block so we have a single
    // exit point at which to restore focus.
    let result: FrameSendResult = async move {
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

        // Post-send verify: re-dump a11y and confirm the message actually
        // landed. xdotool reports exit 0 whether or not wechat consumed the
        // keystroke — observed 2026-05-25 on wxid_xxoxed61kmwv22: five sendFast
        // calls reported ok but wechat never registered the Enter (focus race,
        // input box hadn't quite focused, etc.), so the bubble never appeared
        // in wcdb and the caller's marker logic re-dispatched the inbound msg
        // for ~3 minutes. Without this check the failure is invisible upstream.
        //
        // Poll with early exit instead of a fixed 500ms wait: most sends land
        // within ~150ms, so the first clean poll (input cleared AND bottom
        // bubble matches) returns ok and skips the rest of the wait. Only if the
        // LAST poll still shows an affirmative failure do we flip to ok=false.
        // Best-effort: an a11y dump failure or a missing frame means we can't
        // verify → bail to ok (same leniency as the old single-shot check).
        let sent_trim = text.trim();
        let sent_norm = normalize_bubble(text);
        let mut verify_failure: Option<String> = None;
        for delay in [120u64, 150, 200] {
            tokio::time::sleep(std::time::Duration::from_millis(delay)).await;
            let Ok(post_tree) = get_a11y_app("wechat", options).await else {
                verify_failure = None;
                break;
            };
            let Some(post_frame) = find_frame(&post_tree, frame_name) else {
                verify_failure = None;
                break;
            };
            // Check 1: input box should be empty (wechat clears it on send).
            let input_dirty = find_editable_text(post_frame).is_some_and(|post_input| {
                let remaining = post_input.name.trim();
                !remaining.is_empty()
                    && (remaining == sent_trim || remaining.contains(sent_trim))
            });
            // Check 2: bottom of the Messages list should be the text we just
            // sent (modulo a11y truncation). Absent list/bubble → unknown,
            // treated as "not a mismatch" so it doesn't block early exit.
            let bubble_mismatch = find_messages_list(post_frame)
                .and_then(|l| l.children.as_ref())
                .and_then(|children| {
                    children
                        .iter()
                        .rev()
                        .map(|c| c.name.as_str())
                        .find(|n| !is_timestamp_row(n))
                })
                .is_some_and(|bubble| !bubbles_match(&normalize_bubble(bubble), &sent_norm));
            if !input_dirty && !bubble_mismatch {
                verify_failure = None; // confirmed clean → done early
                break;
            }
            // Not yet confirmed — record the reason and retry; the bubble may
            // simply not have rendered yet. The last iteration's reason sticks.
            verify_failure = Some(if input_dirty {
                "input still holds text after Return".to_string()
            } else {
                "bottom bubble doesn't match sent text".to_string()
            });
        }
        if let Some(reason) = verify_failure {
            return err(format!("post-send verify failed: {reason}"));
        }

        FrameSendResult {
            ok: true,
            error: None,
            window_id: Some(wid),
            input_bounds: Some(bounds),
        }
    }
    .await;

    // Restore focus after the send. We MUST leave focus on a sane window: the
    // slow-path fallback (chat_select / SendMessagePlan) drives the MAIN wechat
    // window, so leaving focus on this popped-out frame breaks the next
    // outbound send that routes through it (the "No action selected" loop,
    // qiafan2-bot Server A 2026-05-25).
    //
    // B1 (transitional): retarget the restore to the MAIN window instead of
    // `prior_active`. prior_active was "whatever was focused before", which is
    // often a *different* popped-out chat frame — the user-visible "reply jumps
    // to a random sub-window" surprise, and a worse landing spot for the slow
    // path than the main window. Resolve the main window by its frame name
    // ("Weixin"); if that can't be uniquely resolved (different WeChat UI
    // locale/version → 0 or >1 matches), fall back to prior_active so there is
    // NO behavior change from before. Best-effort: a cleanup failure must not
    // override the real send result.
    let restore_target: Option<String> = {
        let r = exec_command("xdotool", &["search", "--name", "^Weixin$"], options).await;
        let main_ids: Vec<String> = if r.exit_code == 0 {
            r.stdout
                .lines()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect()
        } else {
            Vec::new()
        };
        match main_ids.len() {
            1 => main_ids.into_iter().next(),
            _ => prior_active.clone(),
        }
    };
    if let Some(target) = restore_target.as_deref() {
        if target != wid_for_restore {
            let _ = exec_command("xdotool", &["windowactivate", "--sync", target], options).await;
        }
    }

    result
}

fn find_messages_list<'a>(node: &'a A11yNode) -> Option<&'a A11yNode> {
    if node.role == "list" && node.name == "Messages" {
        return Some(node);
    }
    if let Some(children) = &node.children {
        for c in children {
            if let Some(found) = find_messages_list(c) {
                return Some(found);
            }
        }
    }
    None
}

fn is_timestamp_row(s: &str) -> bool {
    // Matches "HH:MM" or "HH:MM:SS" (the timestamp rows wechat puts between
    // bubbles). Aligned with A11Y_TIMESTAMP_ROW_RE in monitor.ts.
    let trimmed = s.trim();
    let bytes = trimmed.as_bytes();
    if bytes.len() < 4 || bytes.len() > 8 {
        return false;
    }
    let mut colons = 0;
    for &b in bytes {
        if b == b':' {
            colons += 1;
        } else if !b.is_ascii_digit() {
            return false;
        }
    }
    colons == 1 || colons == 2
}

fn normalize_bubble(s: &str) -> String {
    // Collapse runs of whitespace to single space, then trim. Mirrors
    // normalizeBubbleText in the TS echo-guard so the two layers match.
    let mut out = String::with_capacity(s.len());
    let mut last_was_space = false;
    for c in s.chars() {
        if c.is_whitespace() {
            if !last_was_space {
                out.push(' ');
                last_was_space = true;
            }
        } else {
            out.push(c);
            last_was_space = false;
        }
    }
    out.trim().to_string()
}

fn bubbles_match(a: &str, b: &str) -> bool {
    if a == b {
        return true;
    }
    // a11y truncates long bubbles; tolerate prefix matches once we're past
    // the noise floor for trivially-short strings. Aligned with bubblesMatch
    // in the TS echo-guard.
    if a.chars().count() >= 12 && b.chars().count() >= 12 {
        if a.starts_with(b) || b.starts_with(a) {
            return true;
        }
    }
    false
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
