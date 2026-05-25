use super::Plan;
use crate::ia::actions;
use crate::ia::selectors::query_selector;
use crate::ia::types::*;
use crate::tools::chat_select::{open_chat, OpenChatResult};
use crate::tools::exec::{exec_command, ExecOptions};

pub struct SendMessagePlan;

pub struct SendMessageParams {
    pub chat_id: String,
    pub message: Option<String>,
    pub image_path: Option<String>,
    pub image_mime: Option<String>,
    pub file_path: Option<String>,
}

pub enum SendMessagePhase {
    Opening,
    Focusing,
    Inputting,
    Confirming,
    Done,
}

pub struct SendMessagePlanState {
    pub phase: SendMessagePhase,
    pub open_result: Option<OpenChatResult>,
    pub confirm_attempts: u32,
    pub reopen_attempts: u32,
    pub chat_escape_clicks: u32,
}

fn find_edit_and_send_button(a11y: &A11yNode) -> Option<(&A11yNode, &A11yNode)> {
    let send_btn = query_selector(a11y, r#"push-button[name="Send(S)"]"#)?;
    // Find sibling EDITABLE text node via parent
    // Since we don't have parent refs in the tree-based approach,
    // we search the tree for the pattern
    find_edit_near_send(a11y, send_btn)
}

fn find_edit_near_send<'a>(
    root: &'a A11yNode,
    _send_btn: &A11yNode,
) -> Option<(&'a A11yNode, &'a A11yNode)> {
    // Walk tree looking for a parent that has both an EDITABLE text and Send(S) button
    find_edit_send_pair(root)
}

fn find_edit_send_pair(node: &A11yNode) -> Option<(&A11yNode, &A11yNode)> {
    if let Some(children) = &node.children {
        let send_btn = children
            .iter()
            .find(|c| c.role == "push-button" && c.name == "Send(S)");
        let edit_node = children.iter().find(|c| {
            c.role == "text"
                && c.states
                    .as_ref()
                    .map(|s| s.iter().any(|st| st == "EDITABLE"))
                    .unwrap_or(false)
        });

        if let (Some(edit), Some(send)) = (edit_node, send_btn) {
            return Some((edit, send));
        }

        // Recurse
        for child in children {
            if let Some(result) = find_edit_send_pair(child) {
                return Some(result);
            }
        }
    }
    None
}

#[async_trait::async_trait]
impl Plan for SendMessagePlan {
    type PlanState = SendMessagePlanState;
    type Params = SendMessageParams;

    fn id(&self) -> &str {
        "send_message"
    }

    fn initial_plan_state(&self) -> SendMessagePlanState {
        SendMessagePlanState {
            phase: SendMessagePhase::Opening,
            open_result: None,
            confirm_attempts: 0,
            reopen_attempts: 0,
            chat_escape_clicks: 0,
        }
    }

    fn is_goal_reached(&self, _state: &AppState, plan_state: &SendMessagePlanState) -> bool {
        matches!(plan_state.phase, SendMessagePhase::Done)
    }

    async fn select_action(
        &self,
        state: &AppState,
        params: &SendMessageParams,
        identified: &IdentifiedStates,
        plan_state: &mut SendMessagePlanState,
        a11y: &A11yNode,
        _session_id: &str,
    ) -> Option<SelectedAction> {
        let main_state_id = identified.main_window.as_ref().map(|m| m.state_id.as_str());

        // Dismiss popups
        if state.popup.is_some() && identified.popup.is_some() {
            return Some(SelectedAction {
                action: actions::dismiss_popup(),
                frame: identified
                    .main_window
                    .as_ref()
                    .and_then(|m| m.frame.clone()),
            });
        }

        loop {
            match &plan_state.phase {
                SendMessagePhase::Opening => {
                    if main_state_id != Some("chat") && main_state_id != Some("chat_open") {
                        return None;
                    }

                    if main_state_id == Some("chat_open")
                        && state.main_window.opened_chat_username.as_deref()
                            == Some(params.chat_id.as_str())
                    {
                        plan_state.phase = SendMessagePhase::Focusing;
                        continue;
                    }

                    let chat_list_item = query_selector(a11y, r#"list[name="Chats"] > list-item"#);
                    let click_xy = chat_list_item.and_then(|item| {
                        item.bounds.as_ref().map(|b| {
                            (
                                (b.x + b.width / 2.0).round(),
                                (b.y + b.height / 2.0).round(),
                            )
                        })
                    });

                    // On a wrong-chat retry (set by the Focusing guard below), force
                    // chat-select even though we're already in chat_open — otherwise
                    // open_chat's "already selected" short-circuit would skip again on
                    // the same stale selectSession index that caused the mis-open.
                    let force = main_state_id == Some("chat") || plan_state.reopen_attempts > 0;
                    let result = open_chat(&params.chat_id, force, click_xy).await;

                    if !result.ok {
                        // Self-heal: when we're stuck in `chat` state (chat list
                        // visible, no chat open) and open_chat keeps failing, click
                        // the first visible chat list item via xdotool to escape.
                        // chat-select pokes WeChat's internal selectSession memory
                        // at build-specific offsets; if that index is stale (e.g.
                        // post-restart, or after WeChat dropped focus to the list)
                        // the poke returns ok=false and the plan has no other way
                        // out. A raw xdotool click on any list item naturally
                        // transitions to chat_open on whatever got clicked; the
                        // pre-check at the top of Opening then falls through and
                        // re-runs open_chat from chat_open state, where the
                        // selectSession lookup usually succeeds (and even if it
                        // mis-opens, the Focusing wrong-chat guard catches it).
                        // Capped at 2 clicks per plan instance to avoid looping
                        // when WeChat itself is broken. Observed 2026-05-25 on
                        // qiafan2-bot Server A as "No action selected" loops that
                        // only recovered when a human VNC-clicked the chat list.
                        if main_state_id == Some("chat")
                            && plan_state.chat_escape_clicks < 2
                        {
                            if let Some((x, y)) = click_xy {
                                plan_state.chat_escape_clicks += 1;
                                tracing::warn!(
                                    "[send_message] open_chat failed for {} while stuck in `chat`; clicking first list item to escape (attempt {})",
                                    params.chat_id,
                                    plan_state.chat_escape_clicks
                                );
                                return Some(SelectedAction {
                                    action: actions::sequence(vec![
                                        actions::click_at(x, y),
                                        actions::wait_short(),
                                    ]),
                                    frame: identified
                                        .main_window
                                        .as_ref()
                                        .and_then(|m| m.frame.clone()),
                                });
                            }
                        }
                        return None;
                    }

                    let skipped = result.skipped.unwrap_or(false);
                    plan_state.open_result = Some(result);
                    plan_state.phase = SendMessagePhase::Focusing;

                    if !skipped {
                        return Some(SelectedAction {
                            action: actions::wait_short(),
                            frame: identified
                                .main_window
                                .as_ref()
                                .and_then(|m| m.frame.clone()),
                        });
                    }
                    continue;
                }

                SendMessagePhase::Focusing => {
                    if main_state_id != Some("chat_open") {
                        return None;
                    }

                    // Guard against chat-select landing on the wrong conversation.
                    // chat-select hooks selectSession and rewrites the session index;
                    // when that index is stale or mis-mapped it can return ok=true
                    // (often skipped=true on "already selected") while the UI is still
                    // on a different chat. Without this check we'd Focus → type →
                    // Return into the wrong chat's input box — observed as cross-talk
                    // where APEX_GLORY (perpetually pinned at the top of the chat
                    // list on Server A) received messages destined for other
                    // customers (2026-05-25). Mirrors the receive_transfer guard
                    // added in 136a57f.
                    if let Some(opened) = state.main_window.opened_chat_username.as_deref() {
                        if opened != params.chat_id {
                            if plan_state.reopen_attempts >= 3 {
                                tracing::warn!(
                                    "[send_message] opened wrong chat: expected {}, got {}; giving up after {} reopen attempts",
                                    params.chat_id,
                                    opened,
                                    plan_state.reopen_attempts
                                );
                                return None;
                            }
                            tracing::warn!(
                                "[send_message] opened wrong chat: expected {}, got {}; reopening (attempt {})",
                                params.chat_id,
                                opened,
                                plan_state.reopen_attempts + 1
                            );
                            plan_state.reopen_attempts += 1;
                            plan_state.phase = SendMessagePhase::Opening;
                            continue;
                        }
                    }

                    let found = find_edit_and_send_button(a11y);
                    let (edit_node, _) = match found {
                        Some(f) => f,
                        None => return None,
                    };

                    plan_state.phase = SendMessagePhase::Inputting;

                    let is_focused = edit_node
                        .states
                        .as_ref()
                        .map(|s| s.iter().any(|st| st == "FOCUSED"))
                        .unwrap_or(false);

                    if is_focused {
                        continue;
                    }

                    if let Some(bounds) = &edit_node.bounds {
                        return Some(SelectedAction {
                            action: actions::click_bounds(bounds),
                            frame: identified
                                .main_window
                                .as_ref()
                                .and_then(|m| m.frame.clone()),
                        });
                    }
                    return None;
                }

                SendMessagePhase::Inputting => {
                    let found = find_edit_and_send_button(a11y);
                    if found.is_none() {
                        return None;
                    }

                    plan_state.phase = SendMessagePhase::Confirming;

                    // File
                    if let Some(fp) = &params.file_path {
                        exec_command("paste-file", &[fp], &ExecOptions::default()).await;
                        return Some(SelectedAction {
                            action: actions::sequence(vec![
                                Action::Wait { ms: 100 },
                                Action::Key {
                                    combo: "Return".to_string(),
                                },
                            ]),
                            frame: identified
                                .main_window
                                .as_ref()
                                .and_then(|m| m.frame.clone()),
                        });
                    }

                    // Image
                    if let Some(ip) = &params.image_path {
                        let mut args: Vec<&str> = vec![ip];
                        if let Some(mime) = &params.image_mime {
                            args.push(mime);
                        }
                        exec_command("paste-image", &args, &ExecOptions::default()).await;
                        return Some(SelectedAction {
                            action: actions::sequence(vec![
                                Action::Wait { ms: 100 },
                                Action::Key {
                                    combo: "Return".to_string(),
                                },
                            ]),
                            frame: identified
                                .main_window
                                .as_ref()
                                .and_then(|m| m.frame.clone()),
                        });
                    }

                    // Text
                    if let Some(msg) = &params.message {
                        return Some(SelectedAction {
                            action: actions::sequence(vec![
                                Action::Key {
                                    combo: "ctrl+a".to_string(),
                                },
                                Action::Type {
                                    text: msg.clone(),
                                    selector: None,
                                },
                                Action::Wait { ms: 100 },
                                Action::Key {
                                    combo: "Return".to_string(),
                                },
                            ]),
                            frame: identified
                                .main_window
                                .as_ref()
                                .and_then(|m| m.frame.clone()),
                        });
                    }

                    return None;
                }

                SendMessagePhase::Confirming => {
                    let found = find_edit_and_send_button(a11y);
                    let (_, send_btn) = match found {
                        Some(f) => f,
                        None => return None,
                    };

                    let is_disabled = send_btn
                        .states
                        .as_ref()
                        .map(|s| s.iter().any(|st| st == "DISABLED"))
                        .unwrap_or(false);

                    if is_disabled {
                        plan_state.phase = SendMessagePhase::Done;
                        return Some(SelectedAction {
                            action: actions::wait_short(),
                            frame: identified
                                .main_window
                                .as_ref()
                                .and_then(|m| m.frame.clone()),
                        });
                    }

                    plan_state.confirm_attempts += 1;
                    if plan_state.confirm_attempts >= 5 {
                        return None;
                    }

                    return Some(SelectedAction {
                        action: actions::wait_short(),
                        frame: identified
                            .main_window
                            .as_ref()
                            .and_then(|m| m.frame.clone()),
                    });
                }

                SendMessagePhase::Done => return None,
            }
        }
    }
}
