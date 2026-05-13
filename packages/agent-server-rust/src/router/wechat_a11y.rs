use axum::{extract::Query, Json};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::ia::types::{A11yNode, Bounds};
use crate::tools::a11y::get_a11y_app;
use crate::tools::exec::{exec_command, ExecOptions};

#[derive(Deserialize, Default)]
pub struct A11yStateParams {
    #[serde(default, rename = "autoOpen")]
    auto_open: bool,
    #[serde(default = "default_include_messages", rename = "includeMessages")]
    include_messages: bool,
}

fn default_include_messages() -> bool {
    true
}

#[derive(Serialize)]
pub struct ChatUnread {
    pub name: String,
    pub unread: u32,
    #[serde(rename = "mediaTags")]
    pub media_tags: Vec<String>,
    pub preview: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub time: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bounds: Option<Bounds>,
    pub open: bool,
}

#[derive(Serialize)]
pub struct A11yMessage {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bounds: Option<Bounds>,
}

pub async fn a11y_state(Query(params): Query<A11yStateParams>) -> Json<Value> {
    // Limit the a11y dump to the wechat application subtree only (≈2× faster
    // than walking the whole desktop, which contains dbus / fluxbox / etc.).
    let tree = match get_a11y_app("wechat", &ExecOptions::default()).await {
        Ok(t) => t,
        Err(e) => {
            return Json(json!({
                "error": format!("a11y dump failed: {e}"),
            }))
        }
    };

    // The dump root IS the wechat application node, so wechat_app == &tree.
    let wechat_app =
        find_first(&tree, &|n: &A11yNode| n.role == "application" && n.name == "wechat");

    let open_frames: Vec<String> = wechat_app
        .map(collect_top_level_frames)
        .unwrap_or_default();

    let weixin_frame = wechat_app.and_then(|app| {
        app.children
            .as_ref()
            .and_then(|cs| cs.iter().find(|c| c.role == "frame" && c.name == "Weixin"))
    });
    let chats_list =
        weixin_frame.and_then(|f| find_first(f, &|n: &A11yNode| n.role == "list" && n.name == "Chats"));

    let unread_re = Regex::new(r"^(?P<name>.+?)\s+(?P<count>\d+)\s+unread\s+message\(s\)").unwrap();
    let media_re = Regex::new(r"\[(?P<tag>[A-Za-z][A-Za-z ]*)\]").unwrap();
    let time_re = Regex::new(r"(\d{1,2}:\d{2}(?::\d{2})?)\s*$").unwrap();

    let mut chats_with_unread: Vec<ChatUnread> = Vec::new();
    let mut chats_to_open: Vec<(String, f64, f64)> = Vec::new();

    if let Some(list) = chats_list {
        if let Some(items) = &list.children {
            for item in items {
                let raw = &item.name;
                let Some(caps) = unread_re.captures(raw) else {
                    continue;
                };
                let chat_name = caps.name("name").unwrap().as_str().trim().to_string();
                let unread: u32 = caps["count"].parse().unwrap_or(0);

                let media_tags: Vec<String> = media_re
                    .captures_iter(raw)
                    .map(|c| c["tag"].trim().to_string())
                    .collect();
                let time = time_re.captures(raw).map(|c| c[1].to_string());

                let mut preview = unread_re.replace(raw, "").to_string();
                preview = media_re.replace_all(&preview, "").to_string();
                if let Some(ref t) = time {
                    if let Some(idx) = preview.rfind(t) {
                        preview.replace_range(idx..idx + t.len(), "");
                    }
                }
                let preview = preview.trim().to_string();

                let is_open = open_frames.iter().any(|f| f == &chat_name);
                let bounds = item.bounds.clone();

                if params.auto_open && !is_open {
                    if let Some(b) = &bounds {
                        let cx = b.x + b.width / 2.0;
                        let cy = b.y + b.height / 2.0;
                        chats_to_open.push((chat_name.clone(), cx, cy));
                    }
                }

                chats_with_unread.push(ChatUnread {
                    name: chat_name,
                    unread,
                    media_tags,
                    preview,
                    time,
                    bounds,
                    open: is_open,
                });
            }
        }
    }

    let mut messages_per_frame = serde_json::Map::new();
    if params.include_messages {
        if let Some(app) = wechat_app {
            if let Some(frames) = &app.children {
                for fr in frames {
                    if fr.role != "frame" {
                        continue;
                    }
                    if fr.name.is_empty() || fr.name == "Weixin" {
                        continue;
                    }
                    if let Some(msg_list) =
                        find_first(fr, &|n: &A11yNode| n.role == "list" && n.name == "Messages")
                    {
                        if let Some(items) = &msg_list.children {
                            let arr: Vec<Value> = items
                                .iter()
                                .map(|m| {
                                    json!({
                                        "name": m.name,
                                        "bounds": m.bounds,
                                    })
                                })
                                .collect();
                            messages_per_frame.insert(fr.name.clone(), Value::Array(arr));
                        }
                    }
                }
            }
        }
    }

    let mut opened: Vec<String> = Vec::new();
    let mut open_errors: Vec<Value> = Vec::new();
    for (chat, cx, cy) in chats_to_open {
        let opts = ExecOptions::default();
        let x = (cx as i32).to_string();
        let y = (cy as i32).to_string();
        let args = [
            "mousemove",
            "--sync",
            &x,
            &y,
            "click",
            "--repeat",
            "2",
            "--delay",
            "100",
            "1",
        ];
        let res = exec_command("xdotool", &args, &opts).await;
        if res.exit_code == 0 {
            opened.push(chat);
        } else {
            open_errors.push(json!({
                "chat": chat,
                "exitCode": res.exit_code,
                "stderr": res.stderr,
            }));
        }
    }

    Json(json!({
        "openFrames": open_frames,
        "chatsWithUnread": chats_with_unread,
        "messagesPerFrame": messages_per_frame,
        "opened": opened,
        "openErrors": open_errors,
    }))
}

fn find_first<'a>(
    node: &'a A11yNode,
    pred: &dyn Fn(&A11yNode) -> bool,
) -> Option<&'a A11yNode> {
    if pred(node) {
        return Some(node);
    }
    if let Some(children) = &node.children {
        for child in children {
            if let Some(found) = find_first(child, pred) {
                return Some(found);
            }
        }
    }
    None
}

fn collect_top_level_frames(app: &A11yNode) -> Vec<String> {
    app.children
        .as_ref()
        .map(|cs| {
            cs.iter()
                .filter(|c| c.role == "frame")
                .map(|c| c.name.clone())
                .collect()
        })
        .unwrap_or_default()
}
