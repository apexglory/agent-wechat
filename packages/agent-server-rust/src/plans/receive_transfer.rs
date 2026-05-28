use super::Plan;
use crate::ia::actions;
use crate::ia::helpers::{find_frame_for, frame_hint_from_node};
use crate::ia::selectors::query_selector;
use crate::ia::types::*;
use crate::tools::chat_select::{open_chat, OpenChatResult};

const ACCEPT_SELECTOR: &str = r#"push-button[name=/^(确认收钱|Accept|Receive)$/]"#;
const SUCCESS_SELECTOR: &str =
    r#"*[name=/已(收钱|接收|领取)|收款成功|接收成功|领取成功|已存入|Accepted|Received|Success/i]"#;
const DIALOG_CLOSE_SELECTOR: &str =
    r#"push-button[name=/^(Disable|Close|关闭|完成|Done|OK|确定|确认|好|好的|知道了)$/]"#;
const WINDOW_CLOSE_SELECTOR: &str = r#"tool-bar push-button[name="Disable"]"#;
const MAIN_CHAT_SELECTOR: &str = r#"list[name="Chats"]"#;

pub struct ReceiveTransferPlan;

pub struct ReceiveTransferParams {
    pub chat_id: String,
    pub transaction_id: Option<String>,
    pub amount_text: Option<String>,
    pub is_self: bool,
    pub explicit_target: bool,
}

pub enum ReceiveTransferPhase {
    OpeningChat,
    ClickingTransfer,
    ClickingReceive,
    WaitingSuccess,
    ClosingSuccess,
    Done,
}

pub struct ReceiveTransferPlanState {
    pub phase: ReceiveTransferPhase,
    pub open_result: Option<OpenChatResult>,
    pub find_attempts: u32,
    pub receive_attempts: u32,
    pub success_attempts: u32,
    pub close_attempts: u32,
    pub reopen_attempts: u32,
    pub received: bool,
}

fn normalize_amount_text(text: &str) -> String {
    text.chars()
        .filter(|c| c.is_ascii_digit() || *c == '.')
        .collect()
}

fn is_receivable_transfer_item_name(name: &str, expected_amount: Option<&str>) -> bool {
    let lower = name.to_lowercase();
    let transfer_like = name.contains("微信转账")
        || lower.contains("wechat transfer")
        || lower.contains("confirm receipt")
        || name.contains("确认收钱")
        || name.contains("确认收款")
        || name.contains("待收钱")
        || name.contains("待接收")
        || name.contains("收钱");

    if !transfer_like {
        return false;
    }

    let received_like = lower.contains("accepted")
        || lower.contains("received")
        || name.contains("已收")
        || name.contains("已接收")
        || name.contains("已领取")
        || name.contains("已存入");
    let receivable_like = lower.contains("confirm receipt")
        || (lower.contains("receive") && !received_like)
        || name.contains("确认收钱")
        || name.contains("确认收款")
        || name.contains("待收钱")
        || name.contains("待接收")
        || (name.contains("收钱") && !received_like);

    if !receivable_like || received_like {
        return false;
    }

    if let Some(expected_amount) = expected_amount {
        let hint = normalize_amount_text(expected_amount);
        if !hint.is_empty() {
            return normalize_amount_text(name).contains(&hint);
        }
    }

    true
}

fn find_transfer_message<'a>(
    a11y: &'a A11yNode,
    expected_amount: Option<&str>,
) -> Option<&'a A11yNode> {
    let list = query_selector(a11y, r#"list[name="Messages"]"#)?;
    let children = list.children.as_ref()?;
    children.iter().rev().find(|node| {
        node.role == "list-item" && is_receivable_transfer_item_name(&node.name, expected_amount)
    })
}

fn message_list_bounds(a11y: &A11yNode) -> Option<&Bounds> {
    query_selector(a11y, r#"list[name="Messages"]"#)?
        .bounds
        .as_ref()
}

fn click_transfer_card(bubble: &Bounds, list_bounds: Option<&Bounds>, is_self: bool) -> Action {
    // WeChat's a11y reports a list-item's full bounds even when it's scrolled
    // partly out of the Messages viewport. Without clipping, a transfer card
    // sitting at the top of the message history can land its computed center y
    // ABOVE the visible list area, and the click hits the (non-interactive)
    // chat header — receive dialog never opens, ClickingReceive times out,
    // user sees "No action selected". Observed 2026-05-28 on APEX_GLORY's
    // chat: bubble bounds y=44 h=111, list viewport y=101..591, click_y
    // computed as 99 (= 44 + 55), 2 px above the list.
    //
    // Fix: clip the click target's y to the intersection of bubble and
    // viewport before taking the midpoint.
    let (vis_top, vis_bot) = if let Some(lb) = list_bounds {
        (
            bubble.y.max(lb.y),
            (bubble.y + bubble.height).min(lb.y + lb.height),
        )
    } else {
        (bubble.y, bubble.y + bubble.height)
    };
    let y = ((vis_top + vis_bot) / 2.0).round();

    let max_offset = (bubble.width - 24.0).max(bubble.width / 2.0);
    let min_offset = 160.0_f64.min(max_offset);
    let x_offset = (bubble.width * 0.24).clamp(min_offset, max_offset);
    let x = (if is_self {
        bubble.x + bubble.width - x_offset
    } else {
        bubble.x + x_offset
    })
    .round();
    actions::click_at(x, y)
}

fn is_transfer_dialog_frame(frame: &A11yNode) -> bool {
    query_selector(frame, MAIN_CHAT_SELECTOR).is_none()
        && query_selector(frame, r#"list[name="Messages"]"#).is_none()
}

fn find_transfer_dialog_frame_by<'a, F>(a11y: &'a A11yNode, predicate: &F) -> Option<&'a A11yNode>
where
    F: Fn(&A11yNode) -> bool,
{
    fn walk<'a, F>(node: &'a A11yNode, predicate: &F) -> Option<&'a A11yNode>
    where
        F: Fn(&A11yNode) -> bool,
    {
        let mut best: Option<&'a A11yNode> = None;

        if let Some(children) = &node.children {
            for child in children {
                if let Some(frame) = walk(child, predicate) {
                    best = Some(frame);
                }
            }
        }

        if best.is_some() {
            return best;
        }

        if node.role == "frame" && is_transfer_dialog_frame(node) && predicate(node) {
            return Some(node);
        }

        None
    }

    walk(a11y, predicate)
}

fn find_transfer_dialog_frame<'a>(a11y: &'a A11yNode, selector: &str) -> Option<&'a A11yNode> {
    find_transfer_dialog_frame_by(a11y, &|frame| query_selector(frame, selector).is_some())
}

fn find_accept_button(a11y: &A11yNode) -> Option<(&A11yNode, Option<FrameHint>)> {
    if let Some(frame) = find_transfer_dialog_frame(a11y, ACCEPT_SELECTOR) {
        return query_selector(frame, ACCEPT_SELECTOR)
            .map(|btn| (btn, frame_hint_from_node(frame)));
    }

    query_selector(a11y, ACCEPT_SELECTOR).map(|btn| (btn, find_frame_for(a11y, ACCEPT_SELECTOR)))
}

fn find_success_dialog_frame(a11y: &A11yNode) -> Option<&A11yNode> {
    find_transfer_dialog_frame_by(a11y, &|frame| {
        query_selector(frame, SUCCESS_SELECTOR).is_some()
            && query_selector(frame, ACCEPT_SELECTOR).is_none()
    })
}

fn has_receive_success(a11y: &A11yNode) -> bool {
    find_success_dialog_frame(a11y).is_some()
}

fn find_close_button_in_frame(frame: &A11yNode) -> Option<(&A11yNode, Option<FrameHint>)> {
    query_selector(frame, DIALOG_CLOSE_SELECTOR)
        .or_else(|| query_selector(frame, WINDOW_CLOSE_SELECTOR))
        .map(|btn| (btn, frame_hint_from_node(frame)))
}

fn find_any_transfer_dialog_close_button(
    a11y: &A11yNode,
) -> Option<(&A11yNode, Option<FrameHint>)> {
    if let Some(frame) = find_transfer_dialog_frame(a11y, DIALOG_CLOSE_SELECTOR) {
        if let Some(button) = find_close_button_in_frame(frame) {
            return Some(button);
        }
    }

    let frame = find_transfer_dialog_frame(a11y, WINDOW_CLOSE_SELECTOR)?;
    find_close_button_in_frame(frame)
}

fn find_success_close_button(a11y: &A11yNode) -> Option<(&A11yNode, Option<FrameHint>)> {
    let frame = find_success_dialog_frame(a11y)?;
    find_close_button_in_frame(frame)
}

fn receipt_completed_in_chat(
    a11y: &A11yNode,
    main_state_id: Option<&str>,
    expected_amount: Option<&str>,
) -> bool {
    main_state_id == Some("chat_open")
        && query_selector(a11y, r#"list[name="Messages"]"#).is_some()
        && find_accept_button(a11y).is_none()
        && find_transfer_message(a11y, expected_amount).is_none()
}

#[async_trait::async_trait]
impl Plan for ReceiveTransferPlan {
    type PlanState = ReceiveTransferPlanState;
    type Params = ReceiveTransferParams;

    fn id(&self) -> &str {
        "receive_transfer"
    }

    fn initial_plan_state(&self) -> ReceiveTransferPlanState {
        ReceiveTransferPlanState {
            phase: ReceiveTransferPhase::OpeningChat,
            open_result: None,
            find_attempts: 0,
            receive_attempts: 0,
            success_attempts: 0,
            close_attempts: 0,
            reopen_attempts: 0,
            received: false,
        }
    }

    fn is_goal_reached(&self, _state: &AppState, plan_state: &ReceiveTransferPlanState) -> bool {
        matches!(plan_state.phase, ReceiveTransferPhase::Done) && plan_state.received
    }

    async fn select_action(
        &self,
        state: &AppState,
        params: &ReceiveTransferParams,
        identified: &IdentifiedStates,
        plan_state: &mut ReceiveTransferPlanState,
        a11y: &A11yNode,
        _session_id: &str,
    ) -> Option<SelectedAction> {
        let main_state_id = identified.main_window.as_ref().map(|m| m.state_id.as_str());

        tracing::info!(
            "[receive_transfer] enter chat_id={} amount={:?} phase={} main={:?} popup={} opened_username={:?} opened_name={:?} find_attempts={} reopen_attempts={}",
            params.chat_id,
            params.amount_text,
            match plan_state.phase {
                ReceiveTransferPhase::OpeningChat => "OpeningChat",
                ReceiveTransferPhase::ClickingTransfer => "ClickingTransfer",
                ReceiveTransferPhase::ClickingReceive => "ClickingReceive",
                ReceiveTransferPhase::WaitingSuccess => "WaitingSuccess",
                ReceiveTransferPhase::ClosingSuccess => "ClosingSuccess",
                ReceiveTransferPhase::Done => "Done",
            },
            main_state_id,
            identified.popup.as_ref().map(|p| p.state_id.as_str()).unwrap_or("none"),
            state.main_window.opened_chat_username,
            state.main_window.opened_chat_name,
            plan_state.find_attempts,
            plan_state.reopen_attempts,
        );

        // Dismiss other popups if unexpected
        if state.popup.is_some()
            && identified.popup.is_some()
            && matches!(
                plan_state.phase,
                ReceiveTransferPhase::ClickingTransfer | ReceiveTransferPhase::OpeningChat
            )
        {
            return Some(SelectedAction {
                action: actions::dismiss_popup(),
                frame: identified
                    .main_window
                    .as_ref()
                    .and_then(|m| m.frame.clone()),
            });
        }

        loop {
            match plan_state.phase {
                ReceiveTransferPhase::OpeningChat => {
                    if main_state_id != Some("chat") && main_state_id != Some("chat_open") {
                        tracing::warn!(
                            "[receive_transfer] None@OpeningChat: main_state_id={:?} not in (chat, chat_open)",
                            main_state_id
                        );
                        return None;
                    }

                    if main_state_id == Some("chat_open")
                        && state.main_window.opened_chat_username.as_deref()
                            == Some(params.chat_id.as_str())
                    {
                        plan_state.phase = ReceiveTransferPhase::ClickingTransfer;
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

                    // Force a real re-select when we looped back here from the
                    // wrong-chat guard, so chat-select can't skip on a stale
                    // "already selected" belief and leave us on the wrong chat.
                    let force = main_state_id == Some("chat") || plan_state.reopen_attempts > 0;
                    let result = open_chat(&params.chat_id, force, click_xy).await;

                    if !result.ok {
                        tracing::warn!(
                            "[receive_transfer] None@OpeningChat: open_chat failed for {}: error={:?} skipped={:?} frida_diag={:?}",
                            params.chat_id,
                            result.error,
                            result.skipped,
                            result.frida_diag,
                        );
                        return None;
                    }
                    tracing::info!(
                        "[receive_transfer] open_chat ok for {}: skipped={:?} username={:?}",
                        params.chat_id,
                        result.skipped,
                        result.username
                    );

                    let skipped = result.skipped.unwrap_or(false);
                    plan_state.open_result = Some(result);
                    plan_state.phase = ReceiveTransferPhase::ClickingTransfer;

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

                ReceiveTransferPhase::ClickingTransfer => {
                    if main_state_id != Some("chat_open") {
                        tracing::warn!(
                            "[receive_transfer] None@ClickingTransfer: main_state_id={:?} not chat_open",
                            main_state_id
                        );
                        return None;
                    }

                    // Guard against chat-select landing on the wrong conversation.
                    // chat-select switches chats by hooking selectSession and rewriting
                    // the session index; if that index is stale or mis-mapped it can open
                    // a different chat while still reporting ok. Without this check we'd
                    // scroll the wrong chat's history until find_attempts is exhausted and
                    // fail with a meaningless "No action selected" — and, worse, never
                    // surface that the receive ran against the wrong chat.
                    if let Some(opened) = state.main_window.opened_chat_username.as_deref() {
                        if opened != params.chat_id {
                            if plan_state.reopen_attempts >= 3 {
                                tracing::warn!(
                                    "[receive_transfer] opened wrong chat: expected {}, got {}; giving up after {} reopen attempts",
                                    params.chat_id,
                                    opened,
                                    plan_state.reopen_attempts
                                );
                                return None;
                            }
                            tracing::warn!(
                                "[receive_transfer] opened wrong chat: expected {}, got {}; reopening (attempt {})",
                                params.chat_id,
                                opened,
                                plan_state.reopen_attempts + 1
                            );
                            plan_state.reopen_attempts += 1;
                            plan_state.find_attempts = 0;
                            plan_state.phase = ReceiveTransferPhase::OpeningChat;
                            continue;
                        }
                    }

                    let transfer_node = find_transfer_message(a11y, params.amount_text.as_deref());
                    if let Some(node) = transfer_node {
                        if let Some(bounds) = &node.bounds {
                            let list_b = message_list_bounds(a11y).cloned();
                            plan_state.phase = ReceiveTransferPhase::ClickingReceive;
                            return Some(SelectedAction {
                                action: actions::sequence(vec![
                                    click_transfer_card(bounds, list_b.as_ref(), params.is_self),
                                    actions::wait_short(),
                                ]),
                                frame: identified
                                    .main_window
                                    .as_ref()
                                    .and_then(|m| m.frame.clone()),
                            });
                        }
                    }

                    plan_state.find_attempts += 1;
                    if plan_state.find_attempts > 12 {
                        tracing::warn!(
                            "[receive_transfer] None@ClickingTransfer: find_attempts exceeded for chat={} amount={:?}",
                            params.chat_id, params.amount_text
                        );
                        return None;
                    }

                    if let Some(bounds) = message_list_bounds(a11y) {
                        return Some(SelectedAction {
                            action: actions::sequence(vec![
                                actions::click_bounds(bounds),
                                Action::Scroll {
                                    direction: ScrollDirection::Up,
                                    x: None,
                                    y: None,
                                    amount: Some(if params.explicit_target { 5 } else { 3 }),
                                },
                                actions::wait_short(),
                            ]),
                            frame: identified
                                .main_window
                                .as_ref()
                                .and_then(|m| m.frame.clone()),
                        });
                    }

                    return Some(SelectedAction {
                        action: actions::wait_short(),
                        frame: identified
                            .main_window
                            .as_ref()
                            .and_then(|m| m.frame.clone()),
                    });
                }

                ReceiveTransferPhase::ClickingReceive => {
                    if has_receive_success(a11y) {
                        plan_state.phase = ReceiveTransferPhase::ClosingSuccess;
                        continue;
                    }

                    if receipt_completed_in_chat(a11y, main_state_id, params.amount_text.as_deref())
                    {
                        plan_state.received = true;
                        plan_state.phase = ReceiveTransferPhase::Done;
                        return Some(SelectedAction {
                            action: actions::wait_short(),
                            frame: identified
                                .main_window
                                .as_ref()
                                .and_then(|m| m.frame.clone()),
                        });
                    }

                    if let Some((btn, frame)) = find_accept_button(a11y) {
                        if let Some(bounds) = &btn.bounds {
                            if plan_state.receive_attempts >= 5 {
                                tracing::warn!(
                                    "[receive_transfer] None@ClickingReceive: receive_attempts>=5 (button found but giving up)"
                                );
                                return None;
                            }
                            plan_state.receive_attempts += 1;
                            plan_state.phase = ReceiveTransferPhase::WaitingSuccess;
                            return Some(SelectedAction {
                                action: actions::sequence(vec![
                                    actions::click_bounds(bounds),
                                    actions::wait_short(),
                                ]),
                                frame: frame.or_else(|| {
                                    identified
                                        .main_window
                                        .as_ref()
                                        .and_then(|m| m.frame.clone())
                                }),
                            });
                        }
                    }

                    plan_state.receive_attempts += 1;
                    if plan_state.receive_attempts > 20 {
                        tracing::warn!(
                            "[receive_transfer] None@ClickingReceive: timeout waiting for accept button popup"
                        );
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

                ReceiveTransferPhase::WaitingSuccess => {
                    if has_receive_success(a11y) {
                        plan_state.phase = ReceiveTransferPhase::ClosingSuccess;
                        continue;
                    }

                    if receipt_completed_in_chat(a11y, main_state_id, params.amount_text.as_deref())
                    {
                        plan_state.received = true;
                        plan_state.phase = ReceiveTransferPhase::Done;
                        return Some(SelectedAction {
                            action: actions::wait_short(),
                            frame: identified
                                .main_window
                                .as_ref()
                                .and_then(|m| m.frame.clone()),
                        });
                    }

                    plan_state.success_attempts += 1;
                    if plan_state.success_attempts > 20 {
                        tracing::warn!(
                            "[receive_transfer] None@WaitingSuccess: success_attempts>20, no success/closeable state observed"
                        );
                        return None;
                    }

                    return Some(SelectedAction {
                        action: actions::wait_short(),
                        frame: find_frame_for(a11y, ACCEPT_SELECTOR).or_else(|| {
                            identified
                                .main_window
                                .as_ref()
                                .and_then(|m| m.frame.clone())
                        }),
                    });
                }

                ReceiveTransferPhase::ClosingSuccess => {
                    if let Some((btn, frame)) = find_success_close_button(a11y) {
                        if let Some(bounds) = &btn.bounds {
                            plan_state.received = true;
                            plan_state.phase = ReceiveTransferPhase::Done;
                            return Some(SelectedAction {
                                action: actions::sequence(vec![
                                    actions::click_bounds(bounds),
                                    actions::wait_short(),
                                ]),
                                frame: frame.or_else(|| {
                                    identified
                                        .main_window
                                        .as_ref()
                                        .and_then(|m| m.frame.clone())
                                }),
                            });
                        }
                    }

                    if !has_receive_success(a11y) {
                        if receipt_completed_in_chat(
                            a11y,
                            main_state_id,
                            params.amount_text.as_deref(),
                        ) {
                            plan_state.received = true;
                            plan_state.phase = ReceiveTransferPhase::Done;
                            return Some(SelectedAction {
                                action: actions::wait_short(),
                                frame: identified
                                    .main_window
                                    .as_ref()
                                    .and_then(|m| m.frame.clone()),
                            });
                        }
                    }

                    if receipt_completed_in_chat(a11y, main_state_id, params.amount_text.as_deref())
                    {
                        plan_state.received = true;
                        plan_state.phase = ReceiveTransferPhase::Done;
                        return Some(SelectedAction {
                            action: actions::wait_short(),
                            frame: identified
                                .main_window
                                .as_ref()
                                .and_then(|m| m.frame.clone()),
                        });
                    }

                    plan_state.close_attempts += 1;
                    if plan_state.close_attempts > 10 {
                        tracing::warn!(
                            "[receive_transfer] None@ClosingSuccess: close_attempts>10"
                        );
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

                ReceiveTransferPhase::Done => {
                    tracing::info!("[receive_transfer] phase=Done, plan exits with received={}", plan_state.received);
                    return None;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        click_transfer_card, find_success_dialog_frame, find_transfer_dialog_frame,
        is_receivable_transfer_item_name, SUCCESS_SELECTOR, WINDOW_CLOSE_SELECTOR,
    };
    use crate::ia::selectors::query_selector;
    use crate::ia::types::{A11yNode, Action, Bounds};

    #[test]
    fn transfer_item_matcher_only_accepts_receivable_cards() {
        assert!(is_receivable_transfer_item_name(
            "￥0.10 Confirm receipt WeChat Transfer",
            Some("￥0.10")
        ));
        assert!(!is_receivable_transfer_item_name(
            "￥0.10 Accepted WeChat Transfer",
            Some("￥0.10")
        ));
        assert!(!is_receivable_transfer_item_name(
            "￥0.20 Confirm receipt WeChat Transfer",
            Some("￥0.10")
        ));
    }

    #[test]
    fn transfer_card_click_uses_message_bubble_side() {
        let bounds = Bounds {
            x: 273.0,
            y: 505.0,
            width: 1004.0,
            height: 111.0,
        };

        let incoming = click_transfer_card(&bounds, None, false);
        let outgoing = click_transfer_card(&bounds, None, true);

        match incoming {
            Action::ClickCoords { x, y } => {
                assert!(x > 430.0);
                assert!(x < 620.0);
                assert_eq!(y, 561.0);
            }
            _ => panic!("expected incoming click coords"),
        }

        match outgoing {
            Action::ClickCoords { x, y } => {
                assert!(x > 930.0);
                assert!(x < 1120.0);
                assert_eq!(y, 561.0);
            }
            _ => panic!("expected outgoing click coords"),
        }
    }

    #[test]
    fn transfer_card_click_clipped_to_visible_viewport() {
        // Regression for 2026-05-28 APEX_GLORY bug: bubble partially scrolled
        // off the top of the Messages list, raw center y landed above the
        // viewport → click missed → ClickingReceive timed out.
        let bubble = Bounds {
            x: 404.0,
            y: 44.0,
            width: 704.0,
            height: 111.0,
        };
        let list = Bounds {
            x: 404.0,
            y: 101.0,
            width: 704.0,
            height: 490.0,
        };

        let action = click_transfer_card(&bubble, Some(&list), false);
        match action {
            Action::ClickCoords { x: _, y } => {
                // Must land inside the Messages viewport.
                assert!(y >= 101.0, "y={y} should be >= list top (101)");
                assert!(y <= 591.0, "y={y} should be <= list bottom (591)");
                // And inside the bubble's visible slice [101, 155].
                assert!(y <= 155.0, "y={y} should be inside visible bubble top half");
            }
            _ => panic!("expected click coords"),
        }
    }

    #[test]
    fn transfer_card_click_unclipped_when_bubble_in_view() {
        // No regression on the happy path: bubble fully inside viewport →
        // click_y is the geometric center of the bubble, same as before.
        let bubble = Bounds {
            x: 273.0,
            y: 505.0,
            width: 1004.0,
            height: 111.0,
        };
        let list = Bounds {
            x: 273.0,
            y: 100.0,
            width: 704.0,
            height: 700.0,
        };
        match click_transfer_card(&bubble, Some(&list), false) {
            Action::ClickCoords { x: _, y } => assert_eq!(y, 561.0),
            _ => panic!("expected click coords"),
        }
    }

    fn node(role: &str, name: &str, children: Vec<A11yNode>) -> A11yNode {
        A11yNode {
            role: role.to_string(),
            name: name.to_string(),
            bounds: None,
            children: if children.is_empty() {
                None
            } else {
                Some(children)
            },
            parent_index: None,
            window: None,
            states: None,
        }
    }

    #[test]
    fn dialog_frame_search_skips_main_chat_frame() {
        let main_frame = node(
            "frame",
            "Weixin",
            vec![
                node("tool-bar", "", vec![node("push-button", "Disable", vec![])]),
                node("list", "Chats", vec![]),
                node(
                    "list",
                    "Messages",
                    vec![node("list-item", "￥1.00 Accepted WeChat Transfer", vec![])],
                ),
            ],
        );
        let dialog_frame = node(
            "frame",
            "Weixin",
            vec![
                node("tool-bar", "", vec![node("push-button", "Disable", vec![])]),
                node(
                    "label",
                    "You've accepted the transfer. The money has been deposited to your Balance.",
                    vec![],
                ),
            ],
        );
        let desktop = node(
            "desktop-frame",
            "main",
            vec![node(
                "application",
                "wechat",
                vec![main_frame, dialog_frame.clone()],
            )],
        );

        let success_frame = find_transfer_dialog_frame(&desktop, SUCCESS_SELECTOR);
        let close_frame = find_transfer_dialog_frame(&desktop, WINDOW_CLOSE_SELECTOR);

        assert!(success_frame.is_some());
        assert!(close_frame.is_some());
        assert!(success_frame.is_some_and(|frame| frame.name == dialog_frame.name));
        assert!(close_frame.is_some_and(|frame| frame.name == dialog_frame.name));
    }

    #[test]
    fn success_dialog_requires_success_text_without_accept_button() {
        let pending_dialog = node(
            "frame",
            "Weixin",
            vec![
                node("label", "Transfer", vec![]),
                node("push-button", "Accept", vec![]),
                node("tool-bar", "", vec![node("push-button", "Disable", vec![])]),
            ],
        );
        let success_dialog = node(
            "frame",
            "Weixin",
            vec![
                node(
                    "label",
                    "You've accepted the transfer. The money has been deposited to your Balance.",
                    vec![],
                ),
                node("tool-bar", "", vec![node("push-button", "Disable", vec![])]),
            ],
        );
        let desktop = node(
            "desktop-frame",
            "main",
            vec![node(
                "application",
                "wechat",
                vec![pending_dialog, success_dialog.clone()],
            )],
        );

        let frame = find_success_dialog_frame(&desktop);

        assert!(frame.is_some_and(|candidate| {
            query_selector(candidate, r#"push-button[name="Accept"]"#).is_none()
                && candidate.name == success_dialog.name
        }));
    }
}
