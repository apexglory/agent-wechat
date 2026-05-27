use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use crate::execution::actions::execute_action;
use crate::ia::actions as ia_actions;
use crate::ia::identify_states;
use crate::ia::types::{A11yNode, SubscriptionEvent};
use crate::sessions::manager::get_session;
use crate::tools::a11y::get_a11y_desktop;
use crate::tools::exec::ExecOptions;
use crate::tools::screenshot::capture_screenshot;
use crate::tools::wechat_db::find_wechat_pid;
use base64::Engine;

/// How often to run the health scan (in seconds).
const SCAN_INTERVAL_SECS: u64 = 1;

/// Kill WeChat if no IA state has been identified for this long (in seconds).
const UNRESPONSIVE_TIMEOUT_SECS: u64 = 60;

/// Delay before restarting WeChat after a crash (in seconds).
const RESTART_DELAY_SECS: u64 = 3;

/// If WeChat crashes this many times within RAPID_WINDOW_SECS, back off.
const MAX_RAPID_RESTARTS: u32 = 5;
const RAPID_WINDOW_SECS: u64 = 60;
const BACKOFF_DELAY_SECS: u64 = 30;

/// Minimum gap between auto-click recovery attempts on the LoginAccount splash.
const LOGIN_RECOVERY_COOLDOWN_SECS: u64 = 30;

/// Where pre-kill diagnostic dumps go. Lives on the persistent `agent-wechat-data`
/// volume so dumps survive container restarts.
const HEALTH_DUMP_ROOT: &str = "/data/health-dumps";

/// Global flag to pause health monitoring during active execution loops.
static MONITORING_PAUSED: AtomicBool = AtomicBool::new(false);

/// Pause health monitoring (call when an execution loop starts).
pub fn pause_monitoring() {
    MONITORING_PAUSED.store(true, Ordering::Relaxed);
}

/// Resume health monitoring (call when an execution loop ends).
pub fn resume_monitoring() {
    MONITORING_PAUSED.store(false, Ordering::Relaxed);
}

/// Spawn WeChat process for the given session using the shared launch script.
fn spawn_wechat(session: &crate::ia::types::Session) {
    // Use DBUS_SESSION_BUS_ADDRESS from our own environment (inherited from
    // entrypoint.sh) rather than the DB value. The entrypoint's D-Bus session
    // is the one AT-SPI is connected to, so WeChat must use it for a11y to work.
    let result = std::process::Command::new("/opt/tools/launch-wechat")
        .env("DISPLAY", &session.display)
        .env("WECHAT_HOME", format!("/home/{}", session.linux_user))
        .env("WECHAT_USER", &session.linux_user)
        .spawn();

    match result {
        Ok(_) => tracing::info!("[health] Spawned WeChat for session '{}'", session.name),
        Err(e) => tracing::error!("[health] Failed to spawn WeChat: {}", e),
    }
}

/// Spawn the background health monitor task.
///
/// Every second, it checks the default session's WeChat process by running
/// a11y → identify. Three responsibilities:
///   1. Restart WeChat if its process is gone.
///   2. If `identify` returns no state for 60s straight, dump diagnostics and
///      kill+restart the process. The dump lets us tell "WeChat hung" from
///      "at-spi bridge hung" after the fact, since both look the same here.
///   3. Auto-recover from a freshly-spawned WeChat that lands on the
///      LoginAccount splash ("Enter Weixin"/"Log In") by clicking the login
///      button once per cooldown window. This shadows what LoginPlan does, but
///      runs without anyone calling /login — important because a watchdog-
///      restarted WeChat often shows this splash even when the user is offline.
pub fn spawn_health_monitor() {
    tokio::spawn(async move {
        tracing::info!("[health] WeChat health monitor started");

        let mut last_identified = Instant::now();
        let mut was_running = false;
        let mut restart_count: u32 = 0;
        let mut window_start = Instant::now();
        let mut waiting_restart_since: Option<Instant> = None;
        let mut last_a11y: Option<A11yNode> = None;
        let mut last_screenshot_b64: Option<String> = None;
        let mut last_login_click: Option<Instant> = None;

        loop {
            tokio::time::sleep(std::time::Duration::from_secs(SCAN_INTERVAL_SECS)).await;

            // Skip if monitoring is paused (an execution loop is active)
            if MONITORING_PAUSED.load(Ordering::Relaxed) {
                last_identified = Instant::now();
                continue;
            }

            // Only monitor the default session
            let session = match get_session("default") {
                Some(s) if s.status == "running" => s,
                _ => {
                    last_identified = Instant::now();
                    continue;
                }
            };

            // Check if WeChat process is even running
            let wechat_pid = match find_wechat_pid() {
                Some(pid) => {
                    if !was_running {
                        tracing::info!("[health] WeChat process found (pid={})", pid);
                        was_running = true;
                        waiting_restart_since = None;
                    }
                    pid
                }
                None => {
                    if was_running {
                        tracing::warn!(
                            "[health] WeChat process disappeared (likely crashed), restarting"
                        );
                        was_running = false;
                        waiting_restart_since = Some(Instant::now());
                    }

                    // Handle restart with crash loop protection
                    if let Some(since) = waiting_restart_since {
                        // Check crash loop
                        if window_start.elapsed().as_secs() > RAPID_WINDOW_SECS {
                            restart_count = 0;
                            window_start = Instant::now();
                        }

                        let delay = if restart_count >= MAX_RAPID_RESTARTS {
                            if since.elapsed().as_secs() == RESTART_DELAY_SECS {
                                tracing::warn!(
                                    "[health] Crash loop detected ({} restarts in {}s), backing off to {}s",
                                    restart_count, RAPID_WINDOW_SECS, BACKOFF_DELAY_SECS
                                );
                            }
                            BACKOFF_DELAY_SECS
                        } else {
                            RESTART_DELAY_SECS
                        };

                        if since.elapsed().as_secs() >= delay {
                            spawn_wechat(&session);
                            restart_count += 1;
                            // Reset the timer instead of clearing it: if the new
                            // process dies before the next scan can observe it,
                            // was_running stays false and the `if was_running`
                            // branch above wouldn't re-arm the timer — leaving
                            // health monitoring permanently stuck. The Some(pid)
                            // branch clears this once a live process is seen.
                            waiting_restart_since = Some(Instant::now());
                        }
                    }

                    last_identified = Instant::now();
                    continue;
                }
            };

            // Run a11y + identify to see if we can detect any state
            let exec_options = ExecOptions {
                session: Some(session.clone()),
                timeout_ms: 10_000,
            };

            let a11y = match get_a11y_desktop(&exec_options).await {
                Ok(tree) => tree,
                Err(_) => {
                    // a11y failed — count as unresponsive, don't reset timer.
                    // Pass through whatever we last managed to capture so the
                    // pre-kill dump still has something useful.
                    check_and_kill(
                        wechat_pid,
                        &last_identified,
                        last_a11y.as_ref(),
                        last_screenshot_b64.as_deref(),
                        "a11y query failed",
                    );
                    continue;
                }
            };

            let screenshot = capture_screenshot(&exec_options).await.unwrap_or_default();
            let identified = identify_states(&a11y, &screenshot);

            // Refresh the rolling diagnostic snapshot so a future kill can dump
            // the freshest tree we saw, not whatever's stale from earlier.
            last_a11y = Some(a11y.clone());
            last_screenshot_b64 = if screenshot.is_empty() {
                None
            } else {
                Some(screenshot.clone())
            };

            if let Some(mw) = identified.main_window.as_ref() {
                // State identified — WeChat is responsive.
                last_identified = Instant::now();

                // Auto-recover: a watchdog-restarted WeChat sitting on the
                // saved-account splash ("Enter Weixin" / "Log In") will stay
                // there forever unless something clicks. Do it ourselves.
                //
                // Guard against clicking through a popup that happens to be
                // sitting on top of the splash — popup might be the real
                // "logged in elsewhere" / risk-control dialog and the user
                // needs to see it.
                if mw.state_id == "login_account" && identified.popup.is_none() {
                    let cooldown_ok = last_login_click
                        .map(|t| t.elapsed().as_secs() >= LOGIN_RECOVERY_COOLDOWN_SECS)
                        .unwrap_or(true);
                    if cooldown_ok {
                        let frame = mw.frame.clone();
                        if try_auto_click_login(&exec_options, &a11y, frame.as_ref()).await {
                            last_login_click = Some(Instant::now());
                        }
                    }
                }
            } else {
                // No state identified — check timeout
                check_and_kill(
                    wechat_pid,
                    &last_identified,
                    Some(&a11y),
                    if screenshot.is_empty() {
                        None
                    } else {
                        Some(screenshot.as_str())
                    },
                    "no IA state matched",
                );
            }
        }
    });
}

/// Try to click the LoginAccount splash button. Returns true if we actually
/// dispatched a click (so the caller can start the cooldown).
///
/// We acquire the global plan lock with try_lock — if a real plan is in flight
/// we just skip and try again on the next tick. The lock guard MUST be held
/// across the click await so xdotool isn't racing the plan loop for focus.
async fn try_auto_click_login(
    exec_options: &ExecOptions,
    a11y: &A11yNode,
    frame: Option<&crate::ia::types::FrameHint>,
) -> bool {
    let Ok(_lock) = crate::execution::try_acquire_plan_lock() else {
        tracing::debug!("[health] auto-login skipped: plan lock busy");
        return false;
    };

    tracing::warn!(
        "[health] LoginAccount splash detected with no plan running — auto-clicking login button"
    );

    let noop_emit: &(dyn Fn(SubscriptionEvent) + Send + Sync) = &(|_| ());
    execute_action(
        &ia_actions::click_login(),
        frame,
        exec_options,
        a11y,
        noop_emit,
    )
    .await;
    true
}

/// If time since last identified state exceeds the timeout, dump diagnostics
/// then kill the WeChat process so the next loop iteration respawns it.
fn check_and_kill(
    wechat_pid: i64,
    last_identified: &Instant,
    a11y: Option<&A11yNode>,
    screenshot_b64: Option<&str>,
    reason: &str,
) {
    let elapsed = last_identified.elapsed();
    if elapsed.as_secs() >= UNRESPONSIVE_TIMEOUT_SECS {
        tracing::warn!(
            "[health] WeChat (pid={}) unresponsive for {}s, killing process",
            wechat_pid,
            elapsed.as_secs()
        );

        // Dump first, then kill. If the dump itself takes a while we don't care
        // — the process is already wedged.
        let dump_dir = dump_diagnostics(wechat_pid, elapsed.as_secs(), reason, a11y, screenshot_b64);
        if let Some(p) = dump_dir {
            tracing::warn!("[health] Pre-kill diagnostics written to {}", p.display());
        }

        let result = std::process::Command::new("kill")
            .args(["-9", &wechat_pid.to_string()])
            .output();

        match result {
            Ok(output) if output.status.success() => {
                tracing::info!(
                    "[health] Killed WeChat pid={}, will restart automatically",
                    wechat_pid
                );
            }
            Ok(output) => {
                tracing::warn!(
                    "[health] kill returned non-zero for pid={}: {}",
                    wechat_pid,
                    String::from_utf8_lossy(&output.stderr)
                );
            }
            Err(e) => {
                tracing::error!("[health] Failed to kill WeChat pid={}: {}", wechat_pid, e);
            }
        }
    } else {
        tracing::debug!(
            "[health] WeChat unresponsive for {}s (threshold: {}s)",
            elapsed.as_secs(),
            UNRESPONSIVE_TIMEOUT_SECS
        );
    }
}

/// Write a snapshot of everything we know about the wedged WeChat process to a
/// timestamped directory. Best-effort — any individual write failing is logged
/// but does not abort the rest of the dump. Returns the dir path on success.
fn dump_diagnostics(
    pid: i64,
    unresponsive_secs: u64,
    reason: &str,
    a11y: Option<&A11yNode>,
    screenshot_b64: Option<&str>,
) -> Option<PathBuf> {
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let dir = PathBuf::from(HEALTH_DUMP_ROOT).join(format!("{ts}-pid{pid}"));

    if let Err(e) = std::fs::create_dir_all(&dir) {
        tracing::error!(
            "[health] Failed to create dump dir {}: {}",
            dir.display(),
            e
        );
        return None;
    }

    // meta.json — minimal context so the dir is self-describing.
    let meta = serde_json::json!({
        "ts_unix": ts,
        "pid": pid,
        "unresponsive_secs": unresponsive_secs,
        "reason": reason,
        "has_a11y": a11y.is_some(),
        "has_screenshot": screenshot_b64.is_some(),
    });
    write_file(&dir, "meta.json", meta.to_string().as_bytes());

    if let Some(tree) = a11y {
        match serde_json::to_vec_pretty(tree) {
            Ok(bytes) => write_file(&dir, "a11y.json", &bytes),
            Err(e) => tracing::warn!("[health] a11y serialize failed: {}", e),
        }
    }

    if let Some(b64) = screenshot_b64 {
        match base64::engine::general_purpose::STANDARD.decode(b64) {
            Ok(bytes) => write_file(&dir, "screenshot.png", &bytes),
            Err(e) => tracing::warn!("[health] screenshot decode failed: {}", e),
        }
    }

    // ps + /proc info. These often give the answer outright (D-state =
    // disk wait, Z = zombie, R but pegged CPU = busy loop, etc.).
    write_file(&dir, "ps.txt", &run_capture("ps", &["-o", "pid,ppid,stat,pcpu,pmem,rss,vsz,etime,wchan:32,cmd", "-p", &pid.to_string()]));
    write_file(&dir, "ps-tree.txt", &run_capture("ps", &["-o", "pid,ppid,stat,pcpu,pmem,rss,etime,cmd", "--forest", "-g", &pid.to_string()]));
    write_file(
        &dir,
        "proc-status.txt",
        &std::fs::read(format!("/proc/{pid}/status")).unwrap_or_default(),
    );
    write_file(
        &dir,
        "proc-wchan.txt",
        &std::fs::read(format!("/proc/{pid}/wchan")).unwrap_or_default(),
    );
    write_file(
        &dir,
        "proc-stack.txt",
        &std::fs::read(format!("/proc/{pid}/stack")).unwrap_or_default(),
    );

    Some(dir)
}

fn write_file(dir: &PathBuf, name: &str, bytes: &[u8]) {
    let path = dir.join(name);
    if let Err(e) = std::fs::write(&path, bytes) {
        tracing::warn!("[health] failed to write {}: {}", path.display(), e);
    }
}

fn run_capture(cmd: &str, args: &[&str]) -> Vec<u8> {
    match std::process::Command::new(cmd).args(args).output() {
        Ok(out) => {
            let mut v = out.stdout;
            if !out.stderr.is_empty() {
                v.extend_from_slice(b"\n--- stderr ---\n");
                v.extend_from_slice(&out.stderr);
            }
            v
        }
        Err(e) => format!("[run_capture] {cmd} failed: {e}\n").into_bytes(),
    }
}
