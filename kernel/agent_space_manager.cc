#include "chrome/browser/agent_kernel/agent_space_manager.h"

#include <atomic>
#include <unordered_map>
#include <utility>

#include "base/command_line.h"
#include "base/json/json_writer.h"
#include "base/no_destructor.h"
#include "base/task/sequenced_task_runner.h"
#include "base/time/time.h"
#include "base/values.h"
#include "chrome/browser/agent_kernel/agent_offscreen_host.h"
#include "chrome/browser/agent_kernel/core/security_guard.h"
#include "chrome/browser/agent_kernel/network_tunnel_provider.h"
#include "chrome/browser/profiles/keep_alive/profile_keep_alive_types.h"
#include "chrome/browser/profiles/keep_alive/scoped_profile_keep_alive.h"
#include "chrome/browser/profiles/profile.h"
#include "chrome/browser/profiles/profile_destroyer.h"
#include "chrome/browser/profiles/profile_selections.h"
#include "components/keep_alive_registry/keep_alive_types.h"
#include "content/browser/renderer_host/render_process_host_impl.h"
#include "content/browser/renderer_host/text_input_manager.h"
#include "content/browser/web_contents/web_contents_impl.h"
#include "content/public/browser/navigation_controller.h"
#include "content/public/browser/navigation_handle.h"
#include "content/public/browser/render_frame_host.h"
#include "content/public/browser/render_process_host.h"
#include "content/public/browser/web_contents.h"
#include "content/public/browser/web_contents_observer.h"
#include "content/public/browser/web_contents_user_data.h"
#include "content/public/common/child_process_id.h"
#include "ui/base/ime/mojom/text_input_state.mojom.h"
#include "ui/base/ime/text_input_type.h"
#include "ui/gfx/geometry/rect.h"
#include "url/gurl.h"

namespace agent_kernel {

namespace {

constexpr int64_t kPrivateOtrDestroyTimeoutSeconds = 30;

// Ensures detached hidden Agent WebContents maintain foreground scheduling
// priority (kUserBlocking) across main-frame process swaps without forcing
// compositor rendering while collapsed.
class AgentBackgroundBoostObserver
    : public content::WebContentsObserver,
      public content::WebContentsUserData<AgentBackgroundBoostObserver> {
 public:
  ~AgentBackgroundBoostObserver() override { SetTrackedProcess(nullptr); }

  void RenderFrameHostChanged(content::RenderFrameHost* old_host,
                              content::RenderFrameHost* new_host) override {
    if (new_host && new_host->IsInPrimaryMainFrame()) {
      SetTrackedProcess(new_host->GetProcess());
    }
  }

  void DidStartNavigation(
      content::NavigationHandle* navigation_handle) override {
    if (!navigation_handle || !navigation_handle->IsInPrimaryMainFrame()) {
      return;
    }
    const std::string& spec = navigation_handle->GetURL().spec();
    if (!core::CheckAgentUrlPolicy(spec).Allowed()) {
      web_contents()->Stop();
      content::NavigationController::LoadURLParams blank(GURL("about:blank"));
      web_contents()->GetController().LoadURLWithParams(blank);
    }
  }

 private:
  friend class content::WebContentsUserData<AgentBackgroundBoostObserver>;

  explicit AgentBackgroundBoostObserver(content::WebContents* web_contents)
      : content::WebContentsObserver(web_contents),
        content::WebContentsUserData<AgentBackgroundBoostObserver>(
            *web_contents) {
    SetTrackedProcess(web_contents->GetPrimaryMainFrame()->GetProcess());
  }

  void SetTrackedProcess(content::RenderProcessHost* new_process) {
    content::ChildProcessId new_id =
        new_process ? new_process->GetID() : content::ChildProcessId();
    if (tracked_process_id_ == new_id) {
      return;
    }
    if (content::RenderProcessHost* old_process =
            content::RenderProcessHost::FromID(tracked_process_id_)) {
      static_cast<content::RenderProcessHostImpl*>(old_process)
          ->OnBoostForBackgroundExecutionRemoved();
    }
    tracked_process_id_ = new_id;
    if (new_process) {
      static_cast<content::RenderProcessHostImpl*>(new_process)
          ->OnBoostForBackgroundExecutionAdded();
    }
  }

  content::ChildProcessId tracked_process_id_;
  WEB_CONTENTS_USER_DATA_KEY_DECL();
};

WEB_CONTENTS_USER_DATA_KEY_IMPL(AgentBackgroundBoostObserver);

// Minimal Agent TabHelper attachment: intentionally omits HistoryTabHelper and
// SessionTabHelper so shared-login Agent browsing never pollutes personal
// browser history or session restore.
void AttachMinimalAgentTabHelpers(content::WebContents* web_contents,
                                  AuthMode /*auth_mode*/) {
  AgentBackgroundBoostObserver::CreateForWebContents(web_contents);
}

std::string DictToJson(const base::DictValue& dict) {
  return base::WriteJson(dict).value_or("{}");
}

NativeTabHostHooks& GlobalNativeTabHostHooks() {
  static base::NoDestructor<NativeTabHostHooks> hooks;
  return *hooks;
}

std::unordered_map<const content::WebContents*, TabAiState>&
GlobalAiTabRegistry() {
  static base::NoDestructor<
      std::unordered_map<const content::WebContents*, TabAiState>>
      registry;
  return *registry;
}

std::atomic<uint64_t>& GlobalAiTabGeneration() {
  static std::atomic<uint64_t> gen{1};
  return gen;
}

}  // namespace

class NativeTabLifecycleObserver : public content::WebContentsObserver {
 public:
  NativeTabLifecycleObserver(AgentSpaceManager* manager,
                             std::string page_id,
                             content::WebContents* wc)
      : content::WebContentsObserver(wc),
        manager_(manager),
        page_id_(std::move(page_id)) {}
  ~NativeTabLifecycleObserver() override = default;

  void WebContentsDestroyed() override {
    if (manager_) {
      AgentSpaceManager* mgr = manager_.get();
      std::string id = page_id_;
      manager_ = nullptr;
      Observe(nullptr);
      mgr->OnNativeTabDestroyed(id);
    }
  }

 private:
  raw_ptr<AgentSpaceManager> manager_;
  std::string page_id_;
};

NativeTabHostHooks::NativeTabHostHooks() = default;
NativeTabHostHooks::NativeTabHostHooks(const NativeTabHostHooks&) = default;
NativeTabHostHooks& NativeTabHostHooks::operator=(const NativeTabHostHooks&) =
    default;
NativeTabHostHooks::NativeTabHostHooks(NativeTabHostHooks&&) = default;
NativeTabHostHooks& NativeTabHostHooks::operator=(NativeTabHostHooks&&) =
    default;
NativeTabHostHooks::~NativeTabHostHooks() = default;

// static
void AgentSpaceManager::SetNativeTabHostHooks(NativeTabHostHooks hooks) {
  GlobalNativeTabHostHooks() = std::move(hooks);
}

// static
TabAiState AgentSpaceManager::GetWebContentsAiState(
    const content::WebContents* web_contents) {
  if (!web_contents) {
    return TabAiState::kNone;
  }
  const auto& reg = GlobalAiTabRegistry();
  auto it = reg.find(web_contents);
  return it != reg.end() ? it->second : TabAiState::kNone;
}

// static
uint64_t AgentSpaceManager::GetAiTabStateGeneration() {
  return GlobalAiTabGeneration().load(std::memory_order_relaxed);
}

AgentPageRecord::AgentPageRecord() = default;

AgentPageRecord::~AgentPageRecord() {
  native_tab_observer.reset();
  native_tab_wc = nullptr;
  // Destroy WebContents before tearing down the offscreen WindowTreeHost so
  // its native aura::Window detaches cleanly before compositor teardown.
  web_contents.reset();
  if (offscreen_host) {
    if (base::SequencedTaskRunner::HasCurrentDefault()) {
      base::SequencedTaskRunner::GetCurrentDefault()->DeleteSoon(
          FROM_HERE, std::move(offscreen_host));
    } else {
      offscreen_host.reset();
    }
  }
}

const char* AuthModeToString(AuthMode mode) {
  switch (mode) {
    case AuthMode::kShared:
      return "shared";
    case AuthMode::kPrivate:
      return "private";
  }
  return "shared";
}

const char* ControlStateToString(ControlState state) {
  switch (state) {
    case ControlState::kAgentRunning:
      return "AGENT_RUNNING";
    case ControlState::kUserObserving:
      return "USER_OBSERVING";
    case ControlState::kUserActive:
      return "USER_ACTIVE";
  }
  return "AGENT_RUNNING";
}

AgentSpaceManager::AgentSpaceManager(Profile* owner_profile)
    : owner_profile_(owner_profile),
      web_contents_delegate_(std::make_unique<AgentWebContentsDelegate>(this)) {
}

AgentSpaceManager::~AgentSpaceManager() = default;

void AgentSpaceManager::SetEventCallback(EventCallback callback) {
  event_callback_ = std::move(callback);
}

void AgentSpaceManager::SetPageDetachHook(PageDetachHook hook) {
  page_detach_hook_ = std::move(hook);
}

void AgentSpaceManager::EmitEvent(const std::string& event_name,
                                  const std::string& params_json) const {
  if (event_callback_) {
    event_callback_(event_name, params_json);
  }
}

void AgentSpaceManager::Shutdown() {
  for (auto& [page_id, page] : pages_) {
    if (page_detach_hook_) {
      page_detach_hook_(page_id);
    }
    if (page->web_contents) {
      web_contents_delegate_->ClearDialogsForWebContents(
          page->web_contents.get());
      page->web_contents->SetDelegate(nullptr);
    }
  }
  pages_.clear();
  SyncGlobalAiTabStates();
  for (auto& [id, space] : spaces_) {
    if (auto* tunnel = NetworkTunnelProvider::GetGlobalInstance()) {
      tunnel->RemoveSpaceScope(id);
    }
    Profile* otr_to_destroy = nullptr;
    if (space->auth_mode == AuthMode::kPrivate && space->effective_profile &&
        space->effective_profile->IsOffTheRecord()) {
      otr_to_destroy = space->effective_profile;
    }
    space->effective_profile = nullptr;
    if (otr_to_destroy) {
      ProfileDestroyer::DestroyOTRProfileWhenAppropriateWithTimeout(
          otr_to_destroy,
          base::Seconds(kPrivateOtrDestroyTimeoutSeconds));
    }
  }
  spaces_.clear();
  profile_keep_alive_.reset();
  keep_alive_.reset();
}

SpaceSnapshot AgentSpaceManager::CreateSpace(
    const std::string& name,
    AuthMode auth_mode,
    const gfx::Size& default_viewport) {
  std::string space_id = "sp_" + std::to_string(next_space_seq_++);

  auto record = std::make_unique<AgentSpaceRecord>();
  record->space_id = space_id;
  record->name = name.empty() ? space_id : name;
  record->auth_mode = auth_mode;
  record->control_state = ControlState::kAgentRunning;
  record->default_viewport =
      (default_viewport.width() > 0 && default_viewport.height() > 0)
          ? default_viewport
          : gfx::Size(1280, 800);

  if (auth_mode == AuthMode::kShared) {
    record->effective_profile = owner_profile_->GetOriginalProfile();
  } else {
    Profile::OTRProfileID otr_id =
        Profile::OTRProfileID::CreateUnique("AgentPrivate");
    record->effective_profile =
        owner_profile_->GetOriginalProfile()->GetOffTheRecordProfile(
            otr_id, /*create_if_needed=*/true);
    if (auto* tunnel = NetworkTunnelProvider::GetGlobalInstance();
        tunnel && record->effective_profile) {
      tunnel->RegisterSpaceContextAlias(space_id,
                                        record->effective_profile->UniqueId());
    }
  }

  SpaceSnapshot snap{record->space_id, record->name, record->auth_mode,
                     record->control_state};
  spaces_.emplace(space_id, std::move(record));
  UpdateKeepAlives();
  return snap;
}

KernelOpResult AgentSpaceManager::CloseSpace(const std::string& space_id) {
  const std::string safe_space_id = space_id;
  auto it = spaces_.find(safe_space_id);
  if (it == spaces_.end()) {
    return KernelOpResult::Error("ERR_SPACE_NOT_FOUND", "Space not found");
  }

  std::vector<std::string> closed_page_ids;
  std::vector<content::WebContents*> native_tabs_to_close;
  for (auto pit = pages_.begin(); pit != pages_.end();) {
    if (pit->second->space_id == safe_space_id) {
      std::string pid = pit->first;
      closed_page_ids.push_back(pid);
      if (page_detach_hook_) {
        page_detach_hook_(pid);
      }
      auto removed = std::move(pit->second);
      pit = pages_.erase(pit);
      if (removed->web_contents) {
        web_contents_delegate_->ClearDialogsForWebContents(
            removed->web_contents.get());
        removed->web_contents->SetDelegate(nullptr);
      } else if (removed->native_tab_wc) {
        if (removed->owned_native_tab) {
          native_tabs_to_close.push_back(removed->native_tab_wc.get());
        }
        removed->native_tab_observer.reset();
        removed->native_tab_wc = nullptr;
      }
      removed.reset();
    } else {
      ++pit;
    }
  }
  SyncGlobalAiTabStates();

  if (GlobalNativeTabHostHooks().close_native_tab) {
    for (content::WebContents* to_close : native_tabs_to_close) {
      GlobalNativeTabHostHooks().close_native_tab.Run(to_close);
    }
  }

  if (auto* tunnel = NetworkTunnelProvider::GetGlobalInstance()) {
    tunnel->RemoveSpaceScope(safe_space_id);
  }

  Profile* otr_to_destroy = nullptr;
  if (it->second->auth_mode == AuthMode::kPrivate &&
      it->second->effective_profile &&
      it->second->effective_profile->IsOffTheRecord()) {
    otr_to_destroy = it->second->effective_profile;
  }
  it->second->effective_profile = nullptr;
  spaces_.erase(it);
  if (otr_to_destroy) {
    ProfileDestroyer::DestroyOTRProfileWhenAppropriateWithTimeout(
        otr_to_destroy,
        base::Seconds(kPrivateOtrDestroyTimeoutSeconds));
  }
  UpdateKeepAlives();

  for (const auto& pid : closed_page_ids) {
    base::DictValue evt;
    evt.Set("pageId", pid);
    evt.Set("spaceId", safe_space_id);
    EmitEvent("page.closed", DictToJson(evt));
  }
  return KernelOpResult::Ok();
}

std::optional<SpaceSnapshot> AgentSpaceManager::GetSpace(
    const std::string& space_id) const {
  auto it = spaces_.find(space_id);
  if (it == spaces_.end()) {
    return std::nullopt;
  }
  return SpaceSnapshot{it->second->space_id, it->second->name,
                       it->second->auth_mode, it->second->control_state};
}

std::vector<SpaceSnapshot> AgentSpaceManager::ListSpaces() const {
  std::vector<SpaceSnapshot> out;
  out.reserve(spaces_.size());
  for (const auto& [id, space] : spaces_) {
    out.push_back(SpaceSnapshot{space->space_id, space->name, space->auth_mode,
                                space->control_state});
  }
  return out;
}

KernelOpResult AgentSpaceManager::OpenPage(const std::string& space_id,
                                           const std::string& url,
                                           std::optional<gfx::Size> viewport,
                                           PageSnapshot* out_page) {
  auto sit = spaces_.find(space_id);
  if (sit == spaces_.end() || !sit->second->effective_profile) {
    return KernelOpResult::Error("ERR_SPACE_NOT_FOUND", "Space not found");
  }
  if (sit->second->control_state == ControlState::kUserActive) {
    return KernelOpResult::Error(
        "ERR_HUMAN_IN_CONTROL",
        "Space is currently under USER_ACTIVE human control");
  }
  if (auto* tunnel = NetworkTunnelProvider::GetGlobalInstance();
      tunnel && !tunnel->CheckNetworkAllowedForSpace(space_id)) {
    return KernelOpResult::Error(
        "ERR_TUNNEL_DISCONNECTED_FAIL_CLOSED",
        "Network blocked by Fail-Closed VPN Kill-Switch");
  }

  const std::string target_url_str = url.empty() ? "about:blank" : url;
  if (auto sec = core::CheckAgentUrlPolicy(target_url_str); !sec.Allowed()) {
    return KernelOpResult::Error("ERR_DOMAIN_DENIED", sec.message);
  }

  gfx::Size effective_viewport = sit->second->default_viewport;
  if (viewport.has_value()) {
    if (viewport->width() <= 0 || viewport->height() <= 0) {
      return KernelOpResult::Error("ERR_INVALID_PARAMS",
                                   "Viewport dimensions must be positive");
    }
    effective_viewport = *viewport;
  }

  std::string page_id = "pg_" + std::to_string(next_page_seq_++);
  auto record = std::make_unique<AgentPageRecord>();
  record->page_id = page_id;
  record->space_id = space_id;
  record->viewport = effective_viewport;

  GURL target_url(target_url_str);
  const bool is_daemon =
      base::CommandLine::ForCurrentProcess()->HasSwitch("agent-daemon");
  content::WebContents* native_wc = nullptr;
  if (!is_daemon && GlobalNativeTabHostHooks().open_native_tab) {
    native_wc = GlobalNativeTabHostHooks().open_native_tab.Run(
        sit->second->effective_profile, target_url);
  }

  if (native_wc) {
    record->native_tab_wc = native_wc;
    record->owned_native_tab = true;
    record->view_attached = true;
    record->native_tab_observer =
        std::make_unique<NativeTabLifecycleObserver>(this, page_id, native_wc);
  } else {
    content::WebContents::CreateParams create_params(
        sit->second->effective_profile);

    std::unique_ptr<content::WebContents> web_contents =
        content::WebContents::Create(create_params);
    auto offscreen_host =
        std::make_unique<AgentOffscreenHost>(effective_viewport);
    offscreen_host->AdoptWebContents(web_contents.get(), effective_viewport);
    web_contents->Resize(gfx::Rect(effective_viewport));
    web_contents->SetDelegate(web_contents_delegate_.get());
    AttachMinimalAgentTabHelpers(web_contents.get(), sit->second->auth_mode);

    content::NavigationController::LoadURLParams load_params(target_url);
    web_contents->GetController().LoadURLWithParams(load_params);
    web_contents->GetPrimaryMainFrame()->GetProcess()->SetIsUsed();

    record->web_contents = std::move(web_contents);
    record->offscreen_host = std::move(offscreen_host);
  }

  PageSnapshot snap = BuildPageSnapshot(*record);
  snap.url = target_url_str;
  pages_.emplace(page_id, std::move(record));
  SyncGlobalAiTabStates();

  if (out_page) {
    *out_page = snap;
  }

  base::DictValue evt;
  evt.Set("pageId", snap.page_id);
  evt.Set("spaceId", snap.space_id);
  evt.Set("url", snap.url);
  evt.Set("capturedFromPopup", false);
  EmitEvent("page.created", DictToJson(evt));

  return KernelOpResult::Ok();
}

content::WebContents* AgentSpaceManager::CapturePopupWebContents(
    content::WebContents* source,
    std::unique_ptr<content::WebContents> new_contents,
    const std::string& target_url) {
  auto source_page_id = FindPageIdByWebContents(source);
  if (!source_page_id.has_value() || !new_contents) {
    return nullptr;
  }
  auto pit = pages_.find(*source_page_id);
  if (pit == pages_.end()) {
    return nullptr;
  }
  const std::string space_id = pit->second->space_id;
  const gfx::Size viewport = pit->second->viewport;
  auto sit = spaces_.find(space_id);
  if (sit == spaces_.end()) {
    return nullptr;
  }

  content::WebContents* raw = new_contents.get();
  auto offscreen_host = std::make_unique<AgentOffscreenHost>(viewport);
  offscreen_host->AdoptWebContents(raw, viewport);
  raw->Resize(gfx::Rect(viewport));
  raw->SetDelegate(web_contents_delegate_.get());
  AttachMinimalAgentTabHelpers(raw, sit->second->auth_mode);
  if (raw->GetPrimaryMainFrame() && raw->GetPrimaryMainFrame()->GetProcess()) {
    raw->GetPrimaryMainFrame()->GetProcess()->SetIsUsed();
  }

  std::string page_id = "pg_" + std::to_string(next_page_seq_++);
  auto record = std::make_unique<AgentPageRecord>();
  record->page_id = page_id;
  record->space_id = space_id;
  record->viewport = viewport;
  record->web_contents = std::move(new_contents);
  record->offscreen_host = std::move(offscreen_host);
  pages_.emplace(page_id, std::move(record));

  base::DictValue evt;
  evt.Set("pageId", page_id);
  evt.Set("spaceId", space_id);
  evt.Set("url", target_url);
  evt.Set("openerPageId", *source_page_id);
  evt.Set("capturedFromPopup", true);
  EmitEvent("page.created", DictToJson(evt));

  return raw;
}

void AgentSpaceManager::CloseWebContents(content::WebContents* web_contents) {
  auto page_id = FindPageIdByWebContents(web_contents);
  if (page_id.has_value()) {
    ClosePage(*page_id);
  }
}

KernelOpResult AgentSpaceManager::ClosePage(const std::string& page_id) {
  const std::string safe_page_id = page_id;
  auto it = pages_.find(safe_page_id);
  if (it == pages_.end()) {
    return KernelOpResult::Error("ERR_PAGE_NOT_FOUND", "Page not found");
  }
  const std::string space_id = it->second->space_id;
  if (auto sit = spaces_.find(space_id);
      sit != spaces_.end() &&
      sit->second->control_state == ControlState::kUserActive) {
    return KernelOpResult::Error(
        "ERR_HUMAN_IN_CONTROL",
        "Space is currently under USER_ACTIVE human control");
  }
  if (page_detach_hook_) {
    page_detach_hook_(safe_page_id);
  }
  auto removed = std::move(it->second);
  pages_.erase(it);
  content::WebContents* to_close = nullptr;
  if (removed->web_contents) {
    web_contents_delegate_->ClearDialogsForWebContents(
        removed->web_contents.get());
    removed->web_contents->SetDelegate(nullptr);
  } else if (removed->native_tab_wc) {
    to_close = removed->owned_native_tab ? removed->native_tab_wc.get() : nullptr;
    removed->native_tab_observer.reset();
    removed->native_tab_wc = nullptr;
  }
  removed.reset();
  SyncGlobalAiTabStates();

  if (to_close && GlobalNativeTabHostHooks().close_native_tab) {
    GlobalNativeTabHostHooks().close_native_tab.Run(to_close);
  }

  base::DictValue evt;
  evt.Set("pageId", safe_page_id);
  evt.Set("spaceId", space_id);
  EmitEvent("page.closed", DictToJson(evt));
  return KernelOpResult::Ok();
}

std::optional<PageSnapshot> AgentSpaceManager::GetPage(
    const std::string& page_id) const {
  auto it = pages_.find(page_id);
  if (it == pages_.end()) {
    return std::nullopt;
  }
  return BuildPageSnapshot(*it->second);
}

std::vector<PageSnapshot> AgentSpaceManager::ListPages(
    const std::optional<std::string>& space_id) const {
  std::vector<PageSnapshot> out;
  for (const auto& [id, page] : pages_) {
    if (!space_id.has_value() || page->space_id == *space_id) {
      out.push_back(BuildPageSnapshot(*page));
    }
  }
  return out;
}

KernelOpResult AgentSpaceManager::AttachView(const std::string& page_id,
                                             bool interactive,
                                             PageSnapshot* out_page,
                                             ControlState* out_state) {
  auto it = pages_.find(page_id);
  if (it == pages_.end()) {
    return KernelOpResult::Error("ERR_PAGE_NOT_FOUND", "Page not found");
  }
  it->second->view_attached = true;
  it->second->mount_count += 1;

  ControlState state = ControlState::kAgentRunning;
  if (auto sit = spaces_.find(it->second->space_id); sit != spaces_.end()) {
    if (interactive) {
      sit->second->control_state = ControlState::kUserActive;
    } else if (sit->second->control_state != ControlState::kUserActive) {
      sit->second->control_state = ControlState::kUserObserving;
    }
    state = sit->second->control_state;
  }

  if (out_page) {
    *out_page = BuildPageSnapshot(*it->second);
  }
  if (out_state) {
    *out_state = state;
  }

  base::DictValue evt;
  evt.Set("spaceId", it->second->space_id);
  evt.Set("pageId", page_id);
  evt.Set("controlState", ControlStateToString(state));
  EmitEvent("takeover.changed", DictToJson(evt));
  return KernelOpResult::Ok();
}

KernelOpResult AgentSpaceManager::DetachView(const std::string& page_id,
                                             PageSnapshot* out_page,
                                             ControlState* out_state) {
  auto it = pages_.find(page_id);
  if (it == pages_.end()) {
    return KernelOpResult::Error("ERR_PAGE_NOT_FOUND", "Page not found");
  }
  it->second->view_attached = false;
  if (it->second->offscreen_host && it->second->web_contents) {
    it->second->offscreen_host->AdoptWebContents(it->second->web_contents.get(),
                                                 it->second->viewport);
  }

  ControlState state = ControlState::kAgentRunning;
  if (auto sit = spaces_.find(it->second->space_id); sit != spaces_.end()) {
    if (sit->second->control_state == ControlState::kUserObserving) {
      sit->second->control_state = ControlState::kAgentRunning;
    }
    state = sit->second->control_state;
  }

  if (out_page) {
    *out_page = BuildPageSnapshot(*it->second);
  }
  if (out_state) {
    *out_state = state;
  }
  return KernelOpResult::Ok();
}

KernelOpResult AgentSpaceManager::RequestTakeover(
    const std::string& space_id,
    const std::optional<std::string>& page_id,
    const std::string& reason) {
  auto sit = spaces_.find(space_id);
  if (sit == spaces_.end()) {
    return KernelOpResult::Error("ERR_SPACE_NOT_FOUND", "Space not found");
  }
  sit->second->control_state = ControlState::kUserActive;
  SyncGlobalAiTabStates();

  base::DictValue evt;
  evt.Set("spaceId", space_id);
  if (page_id.has_value()) {
    evt.Set("pageId", *page_id);
  }
  evt.Set("reason", reason.empty() ? "user_requested" : reason);
  evt.Set("controlState", ControlStateToString(ControlState::kUserActive));
  EmitEvent("takeover.changed", DictToJson(evt));
  return KernelOpResult::Ok();
}

KernelOpResult AgentSpaceManager::ReleaseTakeover(const std::string& space_id) {
  auto sit = spaces_.find(space_id);
  if (sit == spaces_.end()) {
    return KernelOpResult::Error("ERR_SPACE_NOT_FOUND", "Space not found");
  }
  sit->second->control_state = ControlState::kAgentRunning;
  SyncGlobalAiTabStates();

  base::DictValue evt;
  evt.Set("spaceId", space_id);
  evt.Set("controlState", ControlStateToString(ControlState::kAgentRunning));
  EmitEvent("takeover.changed", DictToJson(evt));
  return KernelOpResult::Ok();
}

void AgentSpaceManager::NotifyDialogOpened(content::WebContents* web_contents,
                                           const PendingDialogInfo& info) {
  auto page_id = FindPageIdByWebContents(web_contents);
  if (!page_id.has_value()) {
    return;
  }
  base::DictValue evt;
  evt.Set("pageId", *page_id);
  evt.Set("type", info.type);
  evt.Set("message", info.message);
  evt.Set("defaultPrompt", info.default_prompt);
  evt.Set("url", info.url);
  EmitEvent("dialog.opened", DictToJson(evt));
}

KernelOpResult AgentSpaceManager::HandleDialog(
    const std::string& page_id,
    bool accept,
    const std::optional<std::string>& prompt_text,
    std::string* out_dialog_type) {
  auto it = pages_.find(page_id);
  if (it == pages_.end() || !it->second->web_contents) {
    return KernelOpResult::Error("ERR_PAGE_NOT_FOUND", "Page not found");
  }
  std::string dtype;
  if (!web_contents_delegate_->HandleOpenDialog(
          it->second->web_contents.get(), accept, prompt_text, &dtype)) {
    return KernelOpResult::Error("ERR_DIALOG_NOT_OPEN",
                                 "No open dialog on page");
  }
  if (out_dialog_type) {
    *out_dialog_type = dtype;
  }

  base::DictValue evt;
  evt.Set("pageId", page_id);
  evt.Set("dialogType", dtype);
  evt.Set("accepted", accept);
  if (prompt_text.has_value()) {
    evt.Set("promptText", *prompt_text);
  }
  EmitEvent("dialog.closed", DictToJson(evt));
  return KernelOpResult::Ok();
}

std::vector<std::pair<std::string, PendingDialogInfo>>
AgentSpaceManager::ListOpenDialogs() const {
  std::vector<std::pair<std::string, PendingDialogInfo>> out;
  for (const auto& [page_id, page] : pages_) {
    if (!page->web_contents) {
      continue;
    }
    auto info =
        web_contents_delegate_->GetOpenDialogInfo(page->web_contents.get());
    if (info.has_value()) {
      out.emplace_back(page_id, std::move(*info));
    }
  }
  return out;
}

KernelOpResult AgentSpaceManager::AuthorizeAgentMutation(
    const std::string& page_id) const {
  auto it = pages_.find(page_id);
  if (it == pages_.end() || !it->second->effective_web_contents()) {
    return KernelOpResult::Error("ERR_TARGET_OUT_OF_SCOPE",
                                 "Target is not an Agent-owned page");
  }
  auto sit = spaces_.find(it->second->space_id);
  if (sit == spaces_.end()) {
    return KernelOpResult::Error("ERR_SPACE_NOT_FOUND", "Space not found");
  }
  if (sit->second->control_state == ControlState::kUserActive) {
    return KernelOpResult::Error(
        "ERR_HUMAN_IN_CONTROL",
        "Space is currently under USER_ACTIVE human control");
  }
  if (auto* tunnel = NetworkTunnelProvider::GetGlobalInstance();
      tunnel && !tunnel->CheckNetworkAllowedForSpace(it->second->space_id)) {
    return KernelOpResult::Error(
        "ERR_TUNNEL_DISCONNECTED_FAIL_CLOSED",
        "Network blocked by Fail-Closed VPN Kill-Switch");
  }
  return KernelOpResult::Ok();
}

KernelOpResult AgentSpaceManager::AttachNativeTab(
    const std::string& space_id,
    content::WebContents* web_contents,
    PageSnapshot* out_page) {
  if (!web_contents) {
    return KernelOpResult::Error("ERR_PAGE_NOT_FOUND",
                                 "No active browser tab available");
  }
  if (auto existing = FindPageIdByWebContents(web_contents);
      existing.has_value()) {
    if (out_page) {
      *out_page = BuildPageSnapshot(*pages_.at(*existing));
    }
    return KernelOpResult::Ok();
  }

  const GURL& visible_url = web_contents->GetVisibleURL();
  const std::string url_str =
      visible_url.is_valid() ? visible_url.spec() : "about:blank";
  if (auto sec = core::CheckAgentUrlPolicy(url_str); !sec.Allowed()) {
    return KernelOpResult::Error("ERR_DOMAIN_DENIED", sec.message);
  }

  std::string target_space_id = space_id;
  if (target_space_id.empty()) {
    for (const auto& [sid, sp] : spaces_) {
      if (sp->auth_mode == AuthMode::kShared) {
        target_space_id = sid;
        break;
      }
    }
    if (target_space_id.empty()) {
      target_space_id = CreateSpace("AI Space", AuthMode::kShared).space_id;
    }
  } else if (!spaces_.contains(target_space_id)) {
    return KernelOpResult::Error("ERR_SPACE_NOT_FOUND", "Space not found");
  }

  std::string page_id = "pg_" + std::to_string(next_page_seq_++);
  auto record = std::make_unique<AgentPageRecord>();
  record->page_id = page_id;
  record->space_id = target_space_id;
  record->native_tab_wc = web_contents;
  record->owned_native_tab = false;
  record->view_attached = true;
  record->viewport = web_contents->GetSize().IsEmpty()
                         ? gfx::Size(1280, 800)
                         : web_contents->GetSize();
  record->native_tab_observer =
      std::make_unique<NativeTabLifecycleObserver>(this, page_id, web_contents);

  PageSnapshot snap = BuildPageSnapshot(*record);
  pages_.emplace(page_id, std::move(record));
  SyncGlobalAiTabStates();

  if (out_page) {
    *out_page = snap;
  }

  base::DictValue evt;
  evt.Set("pageId", snap.page_id);
  evt.Set("spaceId", snap.space_id);
  evt.Set("url", snap.url);
  evt.Set("attachedFromNativeTab", true);
  EmitEvent("page.created", DictToJson(evt));
  return KernelOpResult::Ok();
}

KernelOpResult AgentSpaceManager::DetachNativeTab(
    content::WebContents* web_contents) {
  auto page_id = FindPageIdByWebContents(web_contents);
  if (!page_id.has_value()) {
    return KernelOpResult::Error("ERR_PAGE_NOT_FOUND",
                                 "Tab is not attached to AI");
  }
  return DetachNativeTabByPageId(*page_id);
}

KernelOpResult AgentSpaceManager::DetachNativeTabByPageId(
    const std::string& page_id) {
  const std::string safe_page_id = page_id;
  auto it = pages_.find(safe_page_id);
  if (it == pages_.end()) {
    return KernelOpResult::Error("ERR_PAGE_NOT_FOUND", "Page not found");
  }
  const std::string space_id = it->second->space_id;
  if (page_detach_hook_) {
    page_detach_hook_(safe_page_id);
  }
  auto removed = std::move(it->second);
  pages_.erase(it);
  removed->native_tab_observer.reset();
  removed->native_tab_wc = nullptr;
  removed.reset();
  SyncGlobalAiTabStates();

  base::DictValue evt;
  evt.Set("pageId", safe_page_id);
  evt.Set("spaceId", space_id);
  evt.Set("detachedNativeTab", true);
  EmitEvent("page.closed", DictToJson(evt));
  return KernelOpResult::Ok();
}

void AgentSpaceManager::OnNativeTabDestroyed(const std::string& page_id) {
  const std::string safe_page_id = page_id;
  auto it = pages_.find(safe_page_id);
  if (it == pages_.end()) {
    return;
  }
  const std::string space_id = it->second->space_id;
  if (page_detach_hook_) {
    page_detach_hook_(safe_page_id);
  }
  auto removed = std::move(it->second);
  pages_.erase(it);
  removed->native_tab_wc = nullptr;
  removed->native_tab_observer.reset();
  removed.reset();
  SyncGlobalAiTabStates();

  base::DictValue evt;
  evt.Set("pageId", safe_page_id);
  evt.Set("spaceId", space_id);
  EmitEvent("page.closed", DictToJson(evt));
}

std::vector<NativeTabInfo> AgentSpaceManager::ListNativeTabs() const {
  std::vector<NativeTabInfo> tabs;
  if (!GlobalNativeTabHostHooks().list_native_tabs || !owner_profile_) {
    return tabs;
  }
  tabs = GlobalNativeTabHostHooks().list_native_tabs.Run(
      owner_profile_->GetOriginalProfile());
  for (auto& tab : tabs) {
    if (auto pid = FindPageIdByWebContents(tab.web_contents.get());
        pid.has_value()) {
      tab.ai_controlled = true;
      tab.page_id = *pid;
      if (auto pit = pages_.find(*pid); pit != pages_.end()) {
        tab.space_id = pit->second->space_id;
      }
      tab.ai_state = GetWebContentsAiState(tab.web_contents.get());
    }
  }
  return tabs;
}

content::WebContents* AgentSpaceManager::GetActiveNativeTab() const {
  if (!GlobalNativeTabHostHooks().get_active_native_tab || !owner_profile_) {
    return nullptr;
  }
  return GlobalNativeTabHostHooks().get_active_native_tab.Run(
      owner_profile_->GetOriginalProfile());
}

bool AgentSpaceManager::FocusNativeTabByIndex(int tab_index) {
  if (!GlobalNativeTabHostHooks().focus_native_tab) {
    return false;
  }
  for (const auto& tab : ListNativeTabs()) {
    if (tab.tab_index == tab_index && tab.web_contents) {
      return GlobalNativeTabHostHooks().focus_native_tab.Run(
          tab.web_contents.get());
    }
  }
  return false;
}

bool AgentSpaceManager::FocusNativeTabByPageId(const std::string& page_id) {
  if (!GlobalNativeTabHostHooks().focus_native_tab) {
    return false;
  }
  auto it = pages_.find(page_id);
  if (it == pages_.end() || !it->second->native_tab_wc) {
    return false;
  }
  return GlobalNativeTabHostHooks().focus_native_tab.Run(
      it->second->native_tab_wc.get());
}

bool AgentSpaceManager::FocusNextAiNativeTab() {
  if (!GlobalNativeTabHostHooks().focus_native_tab) {
    return false;
  }
  std::vector<content::WebContents*> ai_tabs;
  for (const auto& [id, page] : pages_) {
    if (page->native_tab_wc) {
      ai_tabs.push_back(page->native_tab_wc.get());
    }
  }
  if (ai_tabs.empty()) {
    return false;
  }
  content::WebContents* target =
      ai_tabs[next_focus_ai_cursor_++ % ai_tabs.size()];
  return GlobalNativeTabHostHooks().focus_native_tab.Run(target);
}

void AgentSpaceManager::SyncGlobalAiTabStates() {
  auto& reg = GlobalAiTabRegistry();
  reg.clear();
  for (const auto& [id, page] : pages_) {
    content::WebContents* wc = page->effective_web_contents();
    if (!wc) {
      continue;
    }
    TabAiState st = TabAiState::kRunning;
    if (auto sit = spaces_.find(page->space_id);
        sit != spaces_.end() &&
        sit->second->control_state == ControlState::kUserActive) {
      st = TabAiState::kPaused;
    }
    reg[wc] = st;
  }
  GlobalAiTabGeneration().fetch_add(1, std::memory_order_relaxed);
}

bool AgentSpaceManager::IsAgentOwnedWebContents(
    const content::WebContents* web_contents) const {
  return FindPageIdByWebContents(web_contents).has_value();
}

content::WebContents* AgentSpaceManager::GetWebContentsByPageId(
    const std::string& page_id) const {
  auto it = pages_.find(page_id);
  if (it == pages_.end()) {
    return nullptr;
  }
  return it->second->effective_web_contents();
}

std::optional<std::string> AgentSpaceManager::FindPageIdByWebContents(
    const content::WebContents* web_contents) const {
  if (!web_contents) {
    return std::nullopt;
  }
  for (const auto& [id, page] : pages_) {
    if (page->effective_web_contents() == web_contents) {
      return id;
    }
  }
  return std::nullopt;
}

std::optional<std::string> AgentSpaceManager::GetSpaceIdForPage(
    const std::string& page_id) const {
  auto it = pages_.find(page_id);
  if (it == pages_.end()) {
    return std::nullopt;
  }
  return it->second->space_id;
}

std::string AgentSpaceManager::GetPageUrl(const std::string& page_id) const {
  auto it = pages_.find(page_id);
  if (it == pages_.end() || !it->second->effective_web_contents()) {
    return "";
  }
  const GURL& current = it->second->effective_web_contents()->GetVisibleURL();
  return current.is_valid() ? current.spec() : "";
}

bool AgentSpaceManager::IsPasswordInputFocused(
    const std::string& page_id) const {
  auto it = pages_.find(page_id);
  if (it == pages_.end() || !it->second->effective_web_contents()) {
    return false;
  }
  auto* impl = static_cast<content::WebContentsImpl*>(
      it->second->effective_web_contents());
  content::TextInputManager* tim = impl ? impl->GetTextInputManager() : nullptr;
  if (!tim) {
    return false;
  }
  const ui::mojom::TextInputState* state = tim->GetTextInputState();
  return state && state->type == ui::TEXT_INPUT_TYPE_PASSWORD;
}

PageSnapshot AgentSpaceManager::BuildPageSnapshot(
    const AgentPageRecord& page) const {
  PageSnapshot snap;
  snap.page_id = page.page_id;
  snap.space_id = page.space_id;
  snap.viewport = page.viewport;
  snap.view_attached = page.view_attached;
  snap.mount_count = page.mount_count;
  content::WebContents* wc = page.effective_web_contents();
  if (wc) {
    const GURL& current = wc->GetVisibleURL();
    snap.url = current.is_valid() ? current.spec() : "about:blank";
    snap.has_open_dialog = web_contents_delegate_->HasOpenDialog(wc);
  } else {
    snap.url = "about:blank";
  }
  return snap;
}

void AgentSpaceManager::UpdateKeepAlives() {
  if (!spaces_.empty()) {
    if (!keep_alive_) {
      keep_alive_ = std::make_unique<ScopedKeepAlive>(
          KeepAliveOrigin::REMOTE_DEBUGGING, KeepAliveRestartOption::DISABLED);
    }
    if (!profile_keep_alive_ && owner_profile_) {
      profile_keep_alive_ = std::make_unique<ScopedProfileKeepAlive>(
          owner_profile_->GetOriginalProfile(),
          ProfileKeepAliveOrigin::kRemoteDebugging);
    }
  } else {
    profile_keep_alive_.reset();
    keep_alive_.reset();
  }
}

// static
AgentSpaceManager* AgentSpaceManagerFactory::GetForProfile(Profile* profile) {
  return static_cast<AgentSpaceManager*>(
      GetInstance()->GetServiceForBrowserContext(profile, /*create=*/true));
}

// static
AgentSpaceManagerFactory* AgentSpaceManagerFactory::GetInstance() {
  static base::NoDestructor<AgentSpaceManagerFactory> instance;
  return instance.get();
}

AgentSpaceManagerFactory::AgentSpaceManagerFactory()
    : ProfileKeyedServiceFactory(
          "AgentSpaceManager",
          ProfileSelections::Builder()
              .WithRegular(ProfileSelection::kOriginalOnly)
              .Build()) {}

AgentSpaceManagerFactory::~AgentSpaceManagerFactory() = default;

std::unique_ptr<KeyedService>
AgentSpaceManagerFactory::BuildServiceInstanceForBrowserContext(
    content::BrowserContext* context) const {
  return std::make_unique<AgentSpaceManager>(
      Profile::FromBrowserContext(context));
}

}  // namespace agent_kernel
