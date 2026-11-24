#include "chrome/browser/agent_kernel/agent_ipc_server.h"

#include <chrono>
#include <cstdlib>
#include <optional>
#include <string>
#include <string_view>
#include <utility>

#include "base/command_line.h"
#include "base/containers/span.h"
#include "base/files/file_path.h"
#include "base/functional/bind.h"
#include "base/json/json_reader.h"
#include "base/json/json_writer.h"
#include "base/logging.h"
#include "base/values.h"
#include "chrome/browser/agent_kernel/agent_cdp_bridge.h"
#include "chrome/browser/agent_kernel/agent_space_manager.h"
#include "chrome/browser/agent_kernel/core/security_guard.h"
#include "chrome/browser/agent_kernel/core/uds_posix_server.h"
#include "chrome/browser/agent_kernel/network_tunnel_provider.h"
#include "chrome/browser/agent_kernel/ui/gador_native_ui_config.h"
#include "chrome/browser/profiles/keep_alive/profile_keep_alive_types.h"
#include "chrome/browser/profiles/keep_alive/scoped_profile_keep_alive.h"
#include "chrome/browser/profiles/profile.h"
#include "chrome/browser/themes/theme_service.h"
#include "chrome/browser/themes/theme_service_factory.h"
#include "chrome/common/pref_names.h"
#include "components/bookmarks/common/bookmark_pref_names.h"
#include "components/keep_alive_registry/keep_alive_types.h"
#include "components/prefs/pref_service.h"
#include "content/public/browser/browser_thread.h"
#include "third_party/skia/include/core/SkColor.h"
#include "ui/base/mojom/themes.mojom.h"

namespace agent_kernel {

namespace {

constexpr char kAgentDaemonSwitch[] = "agent-daemon";
constexpr char kNoStartupWindowSwitch[] = "no-startup-window";
constexpr auto kUiDispatchTimeout = std::chrono::seconds(20);

bool IsAgentIpcDisabled() {
  const auto* cmd_line = base::CommandLine::ForCurrentProcess();
  if (cmd_line && cmd_line->HasSwitch("disable-agent-ipc")) {
    return true;
  }
  if (const char* env_disable = std::getenv("AGENT_KERNEL_DISABLE_IPC");
      env_disable && (std::string(env_disable) == "1" ||
                      std::string(env_disable) == "true")) {
    return true;
  }
  return false;
}

bool IsDaemonModeRequested() {
  const auto* cmd_line = base::CommandLine::ForCurrentProcess();
  if (cmd_line && (cmd_line->HasSwitch(kAgentDaemonSwitch) ||
                   cmd_line->HasSwitch(kNoStartupWindowSwitch))) {
    return true;
  }
  if (const char* env_daemon = std::getenv("AGENT_KERNEL_DAEMON");
      env_daemon && (std::string(env_daemon) == "1" ||
                     std::string(env_daemon) == "true")) {
    return true;
  }
  return false;
}

base::FilePath ResolveDefaultSocketPath() {
  if (const auto* cmd_line = base::CommandLine::ForCurrentProcess();
      cmd_line && cmd_line->HasSwitch("agent-socket")) {
    base::FilePath cli_path = cmd_line->GetSwitchValuePath("agent-socket");
    if (!cli_path.empty()) {
      return cli_path;
    }
  }
  if (const char* override_path = std::getenv("AGENT_KERNEL_SOCKET");
      override_path && override_path[0] != '\0') {
    return base::FilePath(override_path);
  }
  if (const char* runtime_dir = std::getenv("XDG_RUNTIME_DIR");
      runtime_dir && runtime_dir[0] != '\0') {
    return base::FilePath(runtime_dir)
        .AppendASCII("gador")
        .AppendASCII("ctl.sock");
  }
  return base::FilePath("/tmp/gador/ctl.sock");
}

std::string SerializeJson(const base::DictValue& dict) {
  return base::WriteJson(dict).value_or("{}");
}

std::string MakeErrorReply(int64_t id,
                           std::string_view code,
                           std::string_view message) {
  base::DictValue err;
  err.Set("code", code);
  err.Set("message", message);
  base::DictValue root;
  root.Set("id", static_cast<int>(id));
  root.Set("error", std::move(err));
  return SerializeJson(root);
}

std::string MakeOkReply(int64_t id, base::Value result) {
  base::DictValue root;
  root.Set("id", static_cast<int>(id));
  root.Set("result", std::move(result));
  return SerializeJson(root);
}

std::string MakeOkReply(int64_t id, base::DictValue result) {
  return MakeOkReply(id, base::Value(std::move(result)));
}

const char* RouteModeToString(RouteMode mode) {
  switch (mode) {
    case RouteMode::kStrictTunnel:
      return "strict_tunnel";
    case RouteMode::kDirectOnly:
      return "direct_only";
    case RouteMode::kCustom:
      return "custom";
  }
  return "direct_only";
}

base::DictValue SpaceToDict(const SpaceSnapshot& s) {
  base::DictValue d;
  d.Set("spaceId", s.space_id);
  d.Set("name", s.name);
  d.Set("authMode", AuthModeToString(s.auth_mode));
  d.Set("controlState", ControlStateToString(s.control_state));
  return d;
}

base::DictValue PageToDict(const PageSnapshot& p) {
  base::DictValue vp;
  vp.Set("width", p.viewport.width());
  vp.Set("height", p.viewport.height());

  base::DictValue d;
  d.Set("pageId", p.page_id);
  d.Set("spaceId", p.space_id);
  d.Set("url", p.url);
  d.Set("viewport", std::move(vp));
  d.Set("viewAttached", p.view_attached);
  d.Set("mountCount", static_cast<int>(p.mount_count));
  d.Set("hasOpenDialog", p.has_open_dialog);
  return d;
}

base::DictValue TunnelToDict(const TunnelStatus& t) {
  base::DictValue d;
  d.Set("scope", t.config.scope);
  d.Set("mode", RouteModeToString(t.config.mode));
  d.Set("osProxyDisabled", t.os_proxy_disabled);
  d.Set("webrtcPolicy", t.config.webrtc_policy);
  d.Set("failClosed", t.config.fail_closed);
  d.Set("tunnelHealthy", t.tunnel_healthy);
  return d;
}

}  // namespace

ChromeBrowserMainExtraPartsAgentKernel::ChromeBrowserMainExtraPartsAgentKernel()
    : socket_path_(ResolveDefaultSocketPath()),
      network_tunnel_provider_(std::make_unique<NetworkTunnelProvider>()) {
  NetworkTunnelProvider::SetGlobalInstance(network_tunnel_provider_.get());
}

ChromeBrowserMainExtraPartsAgentKernel::
    ~ChromeBrowserMainExtraPartsAgentKernel() {
  shutting_down_.store(true);
  if (uds_server_) {
    uds_server_->Stop();
  }
  NetworkTunnelProvider::SetGlobalInstance(nullptr);
}

void ChromeBrowserMainExtraPartsAgentKernel::PostEarlyInitialization() {
  daemon_mode_ = IsDaemonModeRequested();
  if (daemon_mode_) {
    auto* cmd_line = base::CommandLine::ForCurrentProcess();
    if (cmd_line && !cmd_line->HasSwitch(kNoStartupWindowSwitch)) {
      cmd_line->AppendSwitch(kNoStartupWindowSwitch);
    }
    LOG(INFO) << "[gador] Desktop windowless daemon mode enabled "
                 "(no startup window will be shown)";
  }
}

void ChromeBrowserMainExtraPartsAgentKernel::PostProfileInit(
    Profile* profile,
    bool is_initial_profile) {
  if (IsAgentIpcDisabled()) {
    return;
  }
  if (!is_initial_profile || !profile || profile->IsOffTheRecord()) {
    return;
  }

  ui_task_runner_ = content::GetUIThreadTaskRunner({});
  profile_ = profile;
  space_manager_ = AgentSpaceManagerFactory::GetForProfile(profile);

  // In windowless daemon mode, keep the browser and initial profile alive
  // silently in the background with zero visible windows.
  if (daemon_mode_) {
    if (!daemon_keep_alive_) {
      daemon_keep_alive_ = std::make_unique<ScopedKeepAlive>(
          KeepAliveOrigin::REMOTE_DEBUGGING, KeepAliveRestartOption::DISABLED);
    }
    if (!daemon_profile_keep_alive_) {
      daemon_profile_keep_alive_ = std::make_unique<ScopedProfileKeepAlive>(
          profile->GetOriginalProfile(),
          ProfileKeepAliveOrigin::kRemoteDebugging);
    }
  }

  if (space_manager_) {
    cdp_bridge_ = std::make_unique<AgentCdpBridge>(
        space_manager_,
        base::BindRepeating(
            &ChromeBrowserMainExtraPartsAgentKernel::OnCdpMessageOnUiThread,
            base::Unretained(this)));

    space_manager_->SetPageDetachHook([this](const std::string& page_id) {
      FailPendingCdpCallsForPageOnUiThread(page_id);
      if (cdp_bridge_) {
        cdp_bridge_->Detach(page_id);
      }
    });

    space_manager_->SetEventCallback([this](const std::string& event_name,
                                            const std::string& params_json) {
      if (!uds_server_) {
        return;
      }
      auto params_val =
          base::JSONReader::Read(params_json, base::JSON_PARSE_RFC);
      base::DictValue frame;
      frame.Set("event", event_name);
      frame.Set("params",
                params_val.has_value() ? std::move(*params_val)
                                       : base::Value(base::DictValue()));
      uds_server_->Broadcast(SerializeJson(frame));
    });
  }

  if (!uds_server_) {
    uds_server_ = std::make_unique<core::UdsPosixServer>(
        socket_path_.value(),
        [this](const std::string& req) {
          return HandleUdsRequestOnWorkerThread(req);
        },
        [this]() { return BuildReconnectReplayEventsOnWorkerThread(); });

    std::string err;
    if (!uds_server_->Start(&err)) {
      LOG(ERROR) << "[gador] Failed to start UDS server on "
                 << socket_path_.value() << ": " << err;
      uds_server_.reset();
    } else {
      LOG(INFO) << "[gador] UDS control plane listening (0600) at "
                << socket_path_.value();
    }
  }
}

void ChromeBrowserMainExtraPartsAgentKernel::PostMainMessageLoopRun() {
  shutting_down_.store(true);
  FailAllPendingCdpCallsOnUiThread();
  if (space_manager_) {
    space_manager_->SetEventCallback({});
    space_manager_->SetPageDetachHook({});
  }
  if (uds_server_) {
    uds_server_->Stop();
    uds_server_.reset();
  }
  cdp_bridge_.reset();
  space_manager_ = nullptr;
  profile_ = nullptr;
  daemon_profile_keep_alive_.reset();
  daemon_keep_alive_.reset();
  network_tunnel_provider_.reset();
}

std::string
ChromeBrowserMainExtraPartsAgentKernel::HandleUdsRequestOnWorkerThread(
    const std::string& request_json) {
  if (shutting_down_.load() || !ui_task_runner_) {
    return MakeErrorReply(0, "ERR_INTERNAL", "Browser kernel is shutting down");
  }
  auto promise = std::make_shared<std::promise<std::string>>();
  auto future = promise->get_future();

  ui_task_runner_->PostTask(
      FROM_HERE,
      base::BindOnce(
          &ChromeBrowserMainExtraPartsAgentKernel::DispatchRequestOnUiThread,
          base::Unretained(this), request_json, promise));

  if (future.wait_for(kUiDispatchTimeout) != std::future_status::ready) {
    return MakeErrorReply(0, "ERR_INTERNAL", "Kernel UI dispatch timed out");
  }
  return future.get();
}

std::vector<std::string> ChromeBrowserMainExtraPartsAgentKernel::
    BuildReconnectReplayEventsOnWorkerThread() {
  if (shutting_down_.load() || !ui_task_runner_) {
    return {};
  }
  auto promise = std::make_shared<std::promise<std::vector<std::string>>>();
  auto future = promise->get_future();

  ui_task_runner_->PostTask(
      FROM_HERE,
      base::BindOnce(
          [](ChromeBrowserMainExtraPartsAgentKernel* self,
             std::shared_ptr<std::promise<std::vector<std::string>>> p) {
            std::vector<std::string> out;
            if (!self->shutting_down_.load() && self->space_manager_) {
              for (const auto& [page_id, dialog] :
                   self->space_manager_->ListOpenDialogs()) {
                base::DictValue params;
                params.Set("pageId", page_id);
                params.Set("type", dialog.type);
                params.Set("message", dialog.message);
                params.Set("defaultPrompt", dialog.default_prompt);
                params.Set("url", dialog.url);
                params.Set("replayed", true);

                base::DictValue evt;
                evt.Set("event", "dialog.opened");
                evt.Set("params", std::move(params));
                out.push_back(SerializeJson(evt));
              }
            }
            p->set_value(std::move(out));
          },
          base::Unretained(this), promise));

  if (future.wait_for(std::chrono::seconds(5)) != std::future_status::ready) {
    return {};
  }
  return future.get();
}

void ChromeBrowserMainExtraPartsAgentKernel::DispatchRequestOnUiThread(
    const std::string& request_json,
    std::shared_ptr<std::promise<std::string>> reply_promise) {
  if (shutting_down_.load() || !space_manager_) {
    reply_promise->set_value(
        MakeErrorReply(0, "ERR_INTERNAL", "AgentSpaceManager unavailable"));
    return;
  }

  auto parsed = base::JSONReader::ReadDict(request_json, base::JSON_PARSE_RFC);
  if (!parsed.has_value()) {
    reply_promise->set_value(
        MakeErrorReply(0, "ERR_INVALID_PARAMS", "Malformed JSON request"));
    return;
  }

  const int64_t id = parsed->FindInt("id").value_or(0);
  const std::string* method_ptr = parsed->FindString("method");
  if (!method_ptr || method_ptr->empty()) {
    reply_promise->set_value(
        MakeErrorReply(id, "ERR_INVALID_PARAMS", "Missing method"));
    return;
  }
  const std::string& method = *method_ptr;
  const base::DictValue empty_params;
  const base::DictValue& params =
      parsed->FindDict("params") ? *parsed->FindDict("params") : empty_params;

  if (method == "agent.capabilities") {
    base::ListValue features;
    features.Append("dual-mode-auth");
    features.Append("detached-agent-space");
    features.Append("hot-view-mount");
    features.Append("non-blocking-dialogs");
    features.Append("independent-vpn-tunnel");
    features.Append("webmcp-ready");
    features.Append("windowless-daemon");
    features.Append("credential-payment-guard");
    features.Append("native-views-ui-bridge");

    base::ListValue auth_modes;
    auth_modes.Append("shared");
    auth_modes.Append("private");

    base::ListValue net_policies;
    net_policies.Append("strict_tunnel");
    net_policies.Append("direct_only");
    net_policies.Append("custom");

    base::DictValue res;
    res.Set("protocolVersion", "0.1.0");
    res.Set("chromiumVersion", "158.0.8127.36");
    res.Set("runtimeMode", daemon_mode_ ? "daemon" : "desktop");
    res.Set("windowShownByDefault", !daemon_mode_);
    res.Set("features", std::move(features));
    res.Set("authModes", std::move(auth_modes));
    res.Set("networkPolicies", std::move(net_policies));
    reply_promise->set_value(MakeOkReply(id, std::move(res)));
    return;
  }

  if (method == "space.create") {
    const std::string* am = params.FindString("authMode");
    if (!am || (*am != "shared" && *am != "private")) {
      reply_promise->set_value(MakeErrorReply(
          id, "ERR_INVALID_PARAMS", "authMode must be shared or private"));
      return;
    }
    AuthMode mode = (*am == "private") ? AuthMode::kPrivate : AuthMode::kShared;
    const std::string name =
        params.FindString("name") ? *params.FindString("name") : "";
    gfx::Size vp(1280, 800);
    if (const base::DictValue* v = params.FindDict("viewport")) {
      vp = gfx::Size(v->FindInt("width").value_or(1280),
                     v->FindInt("height").value_or(800));
    }
    SpaceSnapshot snap = space_manager_->CreateSpace(name, mode, vp);
    reply_promise->set_value(MakeOkReply(id, SpaceToDict(snap)));
    return;
  }

  if (method == "space.list") {
    base::ListValue list;
    for (const auto& s : space_manager_->ListSpaces()) {
      list.Append(SpaceToDict(s));
    }
    base::DictValue res;
    res.Set("spaces", std::move(list));
    reply_promise->set_value(MakeOkReply(id, std::move(res)));
    return;
  }

  if (method == "space.close") {
    const std::string sid =
        params.FindString("spaceId") ? *params.FindString("spaceId") : "";
    auto st = space_manager_->CloseSpace(sid);
    if (!st.ok) {
      reply_promise->set_value(MakeErrorReply(id, st.error_code, st.message));
      return;
    }
    base::DictValue res;
    res.Set("closed", true);
    reply_promise->set_value(MakeOkReply(id, std::move(res)));
    return;
  }

  if (method == "page.open") {
    const std::string sid =
        params.FindString("spaceId") ? *params.FindString("spaceId") : "";
    const std::string url =
        params.FindString("url") ? *params.FindString("url") : "about:blank";
    std::optional<gfx::Size> vp;
    if (const base::DictValue* v = params.FindDict("viewport")) {
      vp = gfx::Size(v->FindInt("width").value_or(0),
                     v->FindInt("height").value_or(0));
    }
    PageSnapshot page;
    auto st = space_manager_->OpenPage(sid, url, vp, &page);
    if (!st.ok) {
      reply_promise->set_value(MakeErrorReply(id, st.error_code, st.message));
      return;
    }
    reply_promise->set_value(MakeOkReply(id, PageToDict(page)));
    return;
  }

  if (method == "page.list") {
    std::optional<std::string> sid;
    if (const std::string* s = params.FindString("spaceId")) {
      sid = *s;
    }
    base::ListValue list;
    for (const auto& p : space_manager_->ListPages(sid)) {
      list.Append(PageToDict(p));
    }
    base::DictValue res;
    res.Set("pages", std::move(list));
    reply_promise->set_value(MakeOkReply(id, std::move(res)));
    return;
  }

  if (method == "page.close") {
    const std::string pid =
        params.FindString("pageId") ? *params.FindString("pageId") : "";
    auto st = space_manager_->ClosePage(pid);
    if (!st.ok) {
      reply_promise->set_value(MakeErrorReply(id, st.error_code, st.message));
      return;
    }
    base::DictValue res;
    res.Set("closed", true);
    reply_promise->set_value(MakeOkReply(id, std::move(res)));
    return;
  }

  if (method == "page.attachView") {
    const std::string pid =
        params.FindString("pageId") ? *params.FindString("pageId") : "";
    const bool interactive = params.FindBool("interactive").value_or(false);
    PageSnapshot page;
    ControlState cstate = ControlState::kAgentRunning;
    auto st = space_manager_->AttachView(pid, interactive, &page, &cstate);
    if (!st.ok) {
      reply_promise->set_value(MakeErrorReply(id, st.error_code, st.message));
      return;
    }
    base::DictValue res;
    res.Set("pageId", page.page_id);
    res.Set("viewAttached", true);
    res.Set("controlState", ControlStateToString(cstate));
    res.Set("mountCount", static_cast<int>(page.mount_count));
    reply_promise->set_value(MakeOkReply(id, std::move(res)));
    return;
  }

  if (method == "page.detachView") {
    const std::string pid =
        params.FindString("pageId") ? *params.FindString("pageId") : "";
    PageSnapshot page;
    ControlState cstate = ControlState::kAgentRunning;
    auto st = space_manager_->DetachView(pid, &page, &cstate);
    if (!st.ok) {
      reply_promise->set_value(MakeErrorReply(id, st.error_code, st.message));
      return;
    }
    base::DictValue res;
    res.Set("pageId", page.page_id);
    res.Set("viewAttached", false);
    res.Set("controlState", ControlStateToString(cstate));
    reply_promise->set_value(MakeOkReply(id, std::move(res)));
    return;
  }

  if (method == "page.listNativeTabs") {
    base::ListValue list;
    for (const auto& t : space_manager_->ListNativeTabs()) {
      base::DictValue d;
      d.Set("tabIndex", t.tab_index);
      d.Set("url", t.url);
      d.Set("title", t.title);
      d.Set("active", t.active);
      d.Set("aiControlled", t.ai_controlled);
      if (!t.page_id.empty()) {
        d.Set("pageId", t.page_id);
      }
      if (!t.space_id.empty()) {
        d.Set("spaceId", t.space_id);
      }
      d.Set("aiState", t.ai_state == TabAiState::kRunning
                           ? "AGENT_RUNNING"
                           : (t.ai_state == TabAiState::kPaused ? "USER_ACTIVE"
                                                                : "HUMAN"));
      list.Append(std::move(d));
    }
    base::DictValue res;
    res.Set("tabs", std::move(list));
    reply_promise->set_value(MakeOkReply(id, std::move(res)));
    return;
  }

  if (method == "page.attachActiveTab") {
    const std::string sid =
        params.FindString("spaceId") ? *params.FindString("spaceId") : "";
    content::WebContents* target_wc = nullptr;
    if (std::optional<int> idx = params.FindInt("tabIndex"); idx.has_value()) {
      for (const auto& t : space_manager_->ListNativeTabs()) {
        if (t.tab_index == *idx) {
          target_wc = t.web_contents.get();
          break;
        }
      }
    } else {
      target_wc = space_manager_->GetActiveNativeTab();
    }
    PageSnapshot page;
    auto st = space_manager_->AttachNativeTab(sid, target_wc, &page);
    if (!st.ok) {
      reply_promise->set_value(MakeErrorReply(id, st.error_code, st.message));
      return;
    }
    reply_promise->set_value(MakeOkReply(id, PageToDict(page)));
    return;
  }

  if (method == "page.detachTab") {
    const std::string pid =
        params.FindString("pageId") ? *params.FindString("pageId") : "";
    KernelOpResult st;
    if (!pid.empty()) {
      st = space_manager_->DetachNativeTabByPageId(pid);
    } else {
      st = space_manager_->DetachNativeTab(space_manager_->GetActiveNativeTab());
    }
    if (!st.ok) {
      reply_promise->set_value(MakeErrorReply(id, st.error_code, st.message));
      return;
    }
    base::DictValue res;
    res.Set("detached", true);
    reply_promise->set_value(MakeOkReply(id, std::move(res)));
    return;
  }

  if (method == "page.focusTab") {
    bool focused = false;
    if (const std::string* pid = params.FindString("pageId");
        pid && !pid->empty()) {
      focused = space_manager_->FocusNativeTabByPageId(*pid);
    } else if (std::optional<int> idx = params.FindInt("tabIndex");
               idx.has_value()) {
      focused = space_manager_->FocusNativeTabByIndex(*idx);
    } else {
      focused = space_manager_->FocusNextAiNativeTab();
    }
    base::DictValue res;
    res.Set("focused", focused);
    reply_promise->set_value(MakeOkReply(id, std::move(res)));
    return;
  }

  if (method == "takeover.request") {
    const std::string sid =
        params.FindString("spaceId") ? *params.FindString("spaceId") : "";
    std::optional<std::string> pid;
    if (const std::string* p = params.FindString("pageId")) {
      pid = *p;
    }
    const std::string reason = params.FindString("reason")
                                   ? *params.FindString("reason")
                                   : "user_requested";
    auto st = space_manager_->RequestTakeover(sid, pid, reason);
    if (!st.ok) {
      reply_promise->set_value(MakeErrorReply(id, st.error_code, st.message));
      return;
    }
    base::DictValue res;
    res.Set("spaceId", sid);
    res.Set("controlState", "USER_ACTIVE");
    reply_promise->set_value(MakeOkReply(id, std::move(res)));
    return;
  }

  if (method == "takeover.release") {
    const std::string sid =
        params.FindString("spaceId") ? *params.FindString("spaceId") : "";
    auto st = space_manager_->ReleaseTakeover(sid);
    if (!st.ok) {
      reply_promise->set_value(MakeErrorReply(id, st.error_code, st.message));
      return;
    }
    base::DictValue res;
    res.Set("spaceId", sid);
    res.Set("controlState", "AGENT_RUNNING");
    reply_promise->set_value(MakeOkReply(id, std::move(res)));
    return;
  }

  if (method == "dialog.handle") {
    const std::string pid =
        params.FindString("pageId") ? *params.FindString("pageId") : "";
    const bool accept = params.FindBool("accept").value_or(false);
    std::optional<std::string> prompt_text;
    if (const std::string* pt = params.FindString("promptText")) {
      prompt_text = *pt;
    }
    std::string dtype;
    auto st = space_manager_->HandleDialog(pid, accept, prompt_text, &dtype);
    if (!st.ok) {
      reply_promise->set_value(MakeErrorReply(id, st.error_code, st.message));
      return;
    }
    base::DictValue res;
    res.Set("handled", true);
    res.Set("dialogType", dtype);
    reply_promise->set_value(MakeOkReply(id, std::move(res)));
    return;
  }

  if (method == "cdp.send") {
    const std::string pid =
        params.FindString("pageId") ? *params.FindString("pageId") : "";
    const std::string cdp_method =
        params.FindString("cdpMethod") ? *params.FindString("cdpMethod") : "";
    if (cdp_method.empty()) {
      reply_promise->set_value(
          MakeErrorReply(id, "ERR_INVALID_PARAMS", "Missing cdpMethod"));
      return;
    }

    auto auth = space_manager_->AuthorizeAgentMutation(pid);
    if (!auth.ok) {
      reply_promise->set_value(
          MakeErrorReply(id, auth.error_code, auth.message));
      return;
    }
    if (!cdp_bridge_) {
      reply_promise->set_value(
          MakeErrorReply(id, "ERR_INTERNAL", "AgentCdpBridge not initialized"));
      return;
    }

    const base::DictValue* cdp_params = params.FindDict("cdpParams");
    const std::string cdp_params_json =
        cdp_params ? SerializeJson(*cdp_params) : "{}";
    const std::string page_url = space_manager_->GetPageUrl(pid);
    const bool password_focused = space_manager_->IsPasswordInputFocused(pid);
    auto sec = core::CheckCdpPolicy(cdp_method, cdp_params_json, page_url,
                                    password_focused);
    if (sec.verdict == core::SecurityVerdict::kDenyDomain) {
      reply_promise->set_value(
          MakeErrorReply(id, "ERR_DOMAIN_DENIED", sec.message));
      return;
    }
    if (sec.verdict == core::SecurityVerdict::kRequireHumanTakeover) {
      if (auto sid = space_manager_->GetSpaceIdForPage(pid); sid.has_value()) {
        space_manager_->RequestTakeover(*sid, pid, sec.reason);
      }
      reply_promise->set_value(MakeErrorReply(
          id, "ERR_SENSITIVE_ACTION_REQUIRES_HUMAN", sec.message));
      return;
    }

    const int64_t cdp_id = next_cdp_id_++;
    base::DictValue cdp_req;
    cdp_req.Set("id", static_cast<int>(cdp_id));
    cdp_req.Set("method", cdp_method);
    if (cdp_params) {
      cdp_req.Set("params", cdp_params->Clone());
    } else {
      cdp_req.Set("params", base::DictValue());
    }
    if (const std::string* session_id = params.FindString("sessionId");
        session_id && !session_id->empty()) {
      cdp_req.Set("sessionId", *session_id);
    }

    const std::string payload = SerializeJson(cdp_req);
    pending_cdp_calls_.emplace(cdp_id,
                               PendingCdpCall{id, pid, reply_promise});

    if (!cdp_bridge_->DispatchMessage(pid, base::as_byte_span(payload))) {
      pending_cdp_calls_.erase(cdp_id);
      reply_promise->set_value(MakeErrorReply(
          id, "ERR_TARGET_OUT_OF_SCOPE",
          "Failed to attach in-process DevToolsAgentHost to target"));
    }
    return;
  }

  if (method == "network.setTunnel") {
    if (!network_tunnel_provider_) {
      reply_promise->set_value(
          MakeErrorReply(id, "ERR_INTERNAL", "NetworkTunnelProvider missing"));
      return;
    }
    TunnelConfig cfg;
    cfg.scope = params.FindString("scope") ? *params.FindString("scope")
                                           : "browser";

    if (cfg.scope.rfind("space:", 0) == 0) {
      const std::string sid = cfg.scope.substr(6);
      auto sp = space_manager_->GetSpace(sid);
      if (!sp.has_value()) {
        reply_promise->set_value(
            MakeErrorReply(id, "ERR_SPACE_NOT_FOUND", "Space not found"));
        return;
      }
      if (sp->auth_mode != AuthMode::kPrivate) {
        reply_promise->set_value(MakeErrorReply(
            id, "ERR_INVALID_PARAMS",
            "Per-space tunnel override requires authMode=private"));
        return;
      }
    }

    const std::string mode_str = params.FindString("mode")
                                     ? *params.FindString("mode")
                                     : "strict_tunnel";
    if (mode_str == "strict_tunnel") {
      cfg.mode = RouteMode::kStrictTunnel;
    } else if (mode_str == "direct_only") {
      cfg.mode = RouteMode::kDirectOnly;
    } else if (mode_str == "custom") {
      cfg.mode = RouteMode::kCustom;
    } else {
      reply_promise->set_value(
          MakeErrorReply(id, "ERR_INVALID_PARAMS", "Invalid route mode"));
      return;
    }

    if (const std::string* ep = params.FindString("endpoint")) {
      cfg.endpoint = *ep;
    }
    if (const std::string* doh = params.FindString("dohServer")) {
      cfg.doh_server = *doh;
    }
    if (const base::ListValue* bypass = params.FindList("bypassList")) {
      cfg.bypass_list.clear();
      for (const auto& entry : *bypass) {
        if (entry.is_string()) {
          cfg.bypass_list.push_back(entry.GetString());
        }
      }
    }
    if (const std::string* wp = params.FindString("webrtcPolicy")) {
      cfg.webrtc_policy = *wp;
    }
    cfg.fail_closed = params.FindBool("failClosed")
                          .value_or(cfg.mode == RouteMode::kStrictTunnel);

    if (!network_tunnel_provider_->SetTunnel(cfg)) {
      reply_promise->set_value(MakeErrorReply(
          id, "ERR_INVALID_PARAMS",
          "strict_tunnel mode requires a non-empty endpoint"));
      return;
    }

    auto statuses = network_tunnel_provider_->GetStatus(cfg.scope);
    if (statuses.empty()) {
      reply_promise->set_value(
          MakeErrorReply(id, "ERR_INTERNAL", "Tunnel status unavailable"));
      return;
    }
    reply_promise->set_value(MakeOkReply(id, TunnelToDict(statuses[0])));
    return;
  }

  if (method == "network.getStatus") {
    std::optional<std::string> scope;
    if (const std::string* s = params.FindString("scope")) {
      scope = *s;
    }
    base::ListValue routes;
    if (network_tunnel_provider_) {
      for (const auto& t : network_tunnel_provider_->GetStatus(scope)) {
        routes.Append(TunnelToDict(t));
      }
    }
    base::DictValue res;
    res.Set("routes", std::move(routes));
    reply_promise->set_value(MakeOkReply(id, std::move(res)));
    return;
  }

  if (method == "ui.getAppearance") {
    base::DictValue res;
    if (profile_) {
      if (auto* theme_service = ThemeServiceFactory::GetForProfile(profile_)) {
        std::string theme = "system";
        switch (theme_service->GetBrowserColorScheme()) {
          case ThemeService::BrowserColorScheme::kLight:
            theme = "light";
            break;
          case ThemeService::BrowserColorScheme::kDark:
            theme = "dark";
            break;
          default:
            theme = "system";
            break;
        }
        res.Set("theme", theme);
        if (auto c = theme_service->GetUserColor(); c.has_value()) {
          res.Set("accentColor", views_ui::GadorNativeUiConfig::FormatHexColor(*c));
        } else {
          res.Set("accentColor", "");
        }
      }
      if (auto* prefs = profile_->GetPrefs()) {
        const bool vertical = prefs->GetBoolean(prefs::kVerticalTabsEnabled);
        res.Set("layout", vertical ? "sidebar" : "chrome");
        res.Set("compact", prefs->GetBoolean(prefs::kVerticalTabsCollapsedState));
        res.Set("showBookmarkBar",
                prefs->GetBoolean(bookmarks::prefs::kShowBookmarkBar));
      }
    }
    res.Set("nativeUi", views_ui::GadorNativeUiConfig::GetInstance()->ToDict());
    reply_promise->set_value(MakeOkReply(id, std::move(res)));
    return;
  }

  if (method == "ui.setAppearance") {
    if (!profile_) {
      reply_promise->set_value(
          MakeErrorReply(id, "ERR_INTERNAL", "Profile unavailable"));
      return;
    }
    if (params.FindBool("resetDefaults").value_or(false)) {
      if (auto* theme_service = ThemeServiceFactory::GetForProfile(profile_)) {
        theme_service->SetBrowserColorScheme(
            ThemeService::BrowserColorScheme::kSystem);
        theme_service->SetUserColor(std::nullopt);
      }
      if (auto* prefs = profile_->GetPrefs()) {
        prefs->SetBoolean(prefs::kVerticalTabsEnabled, false);
        prefs->SetBoolean(prefs::kVerticalTabsCollapsedState, false);
        prefs->SetBoolean(bookmarks::prefs::kShowBookmarkBar, true);
      }
      views_ui::GadorNativeUiConfig::GetInstance()->ResetDefaults();
    } else {
      if (auto* theme_service = ThemeServiceFactory::GetForProfile(profile_)) {
        if (const std::string* theme = params.FindString("theme")) {
          if (*theme == "light") {
            theme_service->SetBrowserColorScheme(
                ThemeService::BrowserColorScheme::kLight);
          } else if (*theme == "dark") {
            theme_service->SetBrowserColorScheme(
                ThemeService::BrowserColorScheme::kDark);
          } else {
            theme_service->SetBrowserColorScheme(
                ThemeService::BrowserColorScheme::kSystem);
          }
        }
        if (const std::string* accent = params.FindString("accentColor")) {
          if (accent->empty() || *accent == "adaptive") {
            theme_service->SetUserColor(std::nullopt);
            base::DictValue patch;
            patch.Set("tabAccentColor", "#7d98ff");
            views_ui::GadorNativeUiConfig::GetInstance()->UpdateAndPersist(patch);
          } else {
            SkColor c;
            if (views_ui::GadorNativeUiConfig::ParseHexColor(*accent, &c)) {
              const std::string* req_variant = params.FindString("colorVariant");
              std::string variant_str =
                  req_variant ? *req_variant
                              : views_ui::GadorNativeUiConfig::GetInstance()
                                    ->Get()
                                    .color_variant;
              ::ui::mojom::BrowserColorVariant color_variant =
                  ::ui::mojom::BrowserColorVariant::kNeutral;
              if (variant_str == "tonal") {
                color_variant = ::ui::mojom::BrowserColorVariant::kTonalSpot;
              } else if (variant_str == "vibrant") {
                color_variant = ::ui::mojom::BrowserColorVariant::kVibrant;
              }
              theme_service->SetUserColorAndBrowserColorVariant(c, color_variant);
              base::DictValue patch;
              patch.Set("tabAccentColor",
                        views_ui::GadorNativeUiConfig::FormatHexColor(c));
              if (req_variant) {
                patch.Set("colorVariant", *req_variant);
              }
              views_ui::GadorNativeUiConfig::GetInstance()->UpdateAndPersist(
                  patch);
            }
          }
        } else if (const std::string* req_variant =
                       params.FindString("colorVariant")) {
          base::DictValue patch;
          patch.Set("colorVariant", *req_variant);
          views_ui::GadorNativeUiConfig::GetInstance()->UpdateAndPersist(patch);
          if (auto c = theme_service->GetUserColor(); c.has_value()) {
            ::ui::mojom::BrowserColorVariant color_variant =
                ::ui::mojom::BrowserColorVariant::kNeutral;
            if (*req_variant == "tonal") {
              color_variant = ::ui::mojom::BrowserColorVariant::kTonalSpot;
            } else if (*req_variant == "vibrant") {
              color_variant = ::ui::mojom::BrowserColorVariant::kVibrant;
            }
            theme_service->SetUserColorAndBrowserColorVariant(*c, color_variant);
          }
        }
      }
      if (auto* prefs = profile_->GetPrefs()) {
        if (const std::string* layout = params.FindString("layout")) {
          const bool vertical = (*layout == "sidebar" || *layout == "vertical");
          prefs->SetBoolean(prefs::kVerticalTabsEnabled, vertical);
        }
        if (std::optional<bool> compact = params.FindBool("compact");
            compact.has_value()) {
          prefs->SetBoolean(prefs::kVerticalTabsCollapsedState, *compact);
        }
        if (std::optional<bool> bm = params.FindBool("showBookmarkBar");
            bm.has_value()) {
          prefs->SetBoolean(bookmarks::prefs::kShowBookmarkBar, *bm);
        }
      }
      if (const base::DictValue* native_ui = params.FindDict("nativeUi")) {
        views_ui::GadorNativeUiConfig::GetInstance()->UpdateAndPersist(*native_ui);
      } else {
        // Also accept flat aura keys directly
        views_ui::GadorNativeUiConfig::GetInstance()->UpdateAndPersist(params);
      }
    }

    base::DictValue res;
    res.Set("applied", true);
    res.Set("nativeUi", views_ui::GadorNativeUiConfig::GetInstance()->ToDict());
    if (auto* prefs = profile_->GetPrefs()) {
      res.Set("layout", prefs->GetBoolean(prefs::kVerticalTabsEnabled)
                            ? "sidebar"
                            : "chrome");
      res.Set("compact", prefs->GetBoolean(prefs::kVerticalTabsCollapsedState));
      res.Set("showBookmarkBar",
              prefs->GetBoolean(bookmarks::prefs::kShowBookmarkBar));
    }
    reply_promise->set_value(MakeOkReply(id, std::move(res)));
    return;
  }

  reply_promise->set_value(
      MakeErrorReply(id, "ERR_METHOD_NOT_FOUND", "Unknown method: " + method));
}

void ChromeBrowserMainExtraPartsAgentKernel::OnCdpMessageOnUiThread(
    const std::string& page_id,
    base::span<const uint8_t> payload) {
  std::string_view json_str(reinterpret_cast<const char*>(payload.data()),
                            payload.size());
  auto parsed = base::JSONReader::ReadDict(json_str, base::JSON_PARSE_RFC);
  if (!parsed.has_value()) {
    return;
  }

  if (std::optional<int> cdp_id = parsed->FindInt("id"); cdp_id.has_value()) {
    auto it = pending_cdp_calls_.find(*cdp_id);
    if (it == pending_cdp_calls_.end()) {
      return;
    }
    PendingCdpCall pending = std::move(it->second);
    pending_cdp_calls_.erase(it);

    if (const base::DictValue* err = parsed->FindDict("error")) {
      const std::string msg =
          err->FindString("message") ? *err->FindString("message") : "CDP error";
      pending.promise->set_value(
          MakeErrorReply(pending.rpc_id, "ERR_INTERNAL", msg));
    } else if (base::Value* result = parsed->Find("result")) {
      pending.promise->set_value(
          MakeOkReply(pending.rpc_id, std::move(*result)));
    } else {
      pending.promise->set_value(
          MakeOkReply(pending.rpc_id, base::DictValue()));
    }
    return;
  }

  // Unsolicited CDP event -> broadcast to connected UDS clients.
  if (uds_server_) {
    base::DictValue params;
    params.Set("pageId", page_id);
    params.Set("payload", std::move(*parsed));

    base::DictValue frame;
    frame.Set("event", "cdp.event");
    frame.Set("params", std::move(params));
    uds_server_->Broadcast(SerializeJson(frame));
  }
}

void ChromeBrowserMainExtraPartsAgentKernel::
    FailPendingCdpCallsForPageOnUiThread(const std::string& page_id) {
  for (auto it = pending_cdp_calls_.begin(); it != pending_cdp_calls_.end();) {
    if (it->second.page_id == page_id) {
      it->second.promise->set_value(MakeErrorReply(
          it->second.rpc_id, "ERR_PAGE_NOT_FOUND", "Page closed during CDP"));
      it = pending_cdp_calls_.erase(it);
    } else {
      ++it;
    }
  }
}

void ChromeBrowserMainExtraPartsAgentKernel::FailAllPendingCdpCallsOnUiThread() {
  for (auto& [cdp_id, pending] : pending_cdp_calls_) {
    pending.promise->set_value(MakeErrorReply(
        pending.rpc_id, "ERR_INTERNAL", "Browser shutting down"));
  }
  pending_cdp_calls_.clear();
}

}  // namespace agent_kernel
