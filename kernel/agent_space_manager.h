#ifndef CHROME_BROWSER_AGENT_KERNEL_AGENT_SPACE_MANAGER_H_
#define CHROME_BROWSER_AGENT_KERNEL_AGENT_SPACE_MANAGER_H_

#include <cstdint>
#include <functional>
#include <map>
#include <memory>
#include <optional>
#include <string>
#include <utility>
#include <vector>

#include "base/functional/callback.h"
#include "base/memory/raw_ptr.h"
#include "base/no_destructor.h"
#include "chrome/browser/agent_kernel/agent_web_contents_delegate.h"
#include "chrome/browser/profiles/profile_keyed_service_factory.h"
#include "components/keep_alive_registry/scoped_keep_alive.h"
#include "components/keyed_service/core/keyed_service.h"
#include "ui/gfx/geometry/size.h"
#include "url/gurl.h"

class Profile;
class ScopedProfileKeepAlive;

namespace content {
class WebContents;
}  // namespace content

namespace agent_kernel {

class AgentOffscreenHost;
class NativeTabLifecycleObserver;

enum class TabAiState {
  kNone,
  kRunning,
  kPaused,
};

struct NativeTabInfo {
  raw_ptr<content::WebContents> web_contents = nullptr;
  std::string url;
  std::string title;
  bool active = false;
  int tab_index = -1;
  bool ai_controlled = false;
  std::string page_id;
  std::string space_id;
  TabAiState ai_state = TabAiState::kNone;
};

struct NativeTabHostHooks {
  NativeTabHostHooks();
  NativeTabHostHooks(const NativeTabHostHooks&);
  NativeTabHostHooks& operator=(const NativeTabHostHooks&);
  NativeTabHostHooks(NativeTabHostHooks&&);
  NativeTabHostHooks& operator=(NativeTabHostHooks&&);
  ~NativeTabHostHooks();

  base::RepeatingCallback<content::WebContents*(Profile*, const GURL&)>
      open_native_tab;
  base::RepeatingCallback<void(content::WebContents*)> close_native_tab;
  base::RepeatingCallback<content::WebContents*(Profile*)> get_active_native_tab;
  base::RepeatingCallback<std::vector<NativeTabInfo>(Profile*)> list_native_tabs;
  base::RepeatingCallback<bool(content::WebContents*)> focus_native_tab;
};

enum class AuthMode {
  // Single-process shared persistent Profile* (cookies/storage/extensions shared,
  // personal HistoryTabHelper and SessionService intentionally excluded).
  kShared,
  // Isolated ephemeral OTRProfileID (zero shared login state, destroyed on close).
  kPrivate,
};

enum class ControlState {
  kAgentRunning,
  kUserObserving,
  kUserActive,
};

struct AgentPageRecord {
  AgentPageRecord();
  ~AgentPageRecord();

  std::string page_id;
  std::string space_id;
  // Owned offscreen WebContents (used in headless/daemon mode).
  std::unique_ptr<content::WebContents> web_contents;
  std::unique_ptr<AgentOffscreenHost> offscreen_host;
  // Non-owning pointer when hosted directly as a native Browser tab.
  raw_ptr<content::WebContents> native_tab_wc = nullptr;
  std::unique_ptr<NativeTabLifecycleObserver> native_tab_observer;
  bool owned_native_tab = false;
  gfx::Size viewport{1280, 800};
  bool view_attached = false;
  uint64_t mount_count = 0;

  content::WebContents* effective_web_contents() const {
    return native_tab_wc ? native_tab_wc.get() : web_contents.get();
  }
  bool is_native_tab() const { return native_tab_wc != nullptr; }
};

struct AgentSpaceRecord {
  std::string space_id;
  std::string name;
  AuthMode auth_mode = AuthMode::kShared;
  ControlState control_state = ControlState::kAgentRunning;
  gfx::Size default_viewport{1280, 800};
  // Original persistent Profile* for kShared, or unique OTR Profile* for kPrivate.
  raw_ptr<Profile> effective_profile = nullptr;
};

struct SpaceSnapshot {
  std::string space_id;
  std::string name;
  AuthMode auth_mode = AuthMode::kShared;
  ControlState control_state = ControlState::kAgentRunning;
};

struct PageSnapshot {
  std::string page_id;
  std::string space_id;
  std::string url;
  gfx::Size viewport{1280, 800};
  bool view_attached = false;
  uint64_t mount_count = 0;
  bool has_open_dialog = false;
};

struct KernelOpResult {
  bool ok = true;
  std::string error_code;
  std::string message;

  static KernelOpResult Ok() { return {}; }
  static KernelOpResult Error(std::string code, std::string msg) {
    return {false, std::move(code), std::move(msg)};
  }
};

// Owns all AgentSpaces and detached Agent WebContents for a regular Profile.
// Agent WebContents are NEVER added to any personal Browser TabStripModel.
class AgentSpaceManager : public KeyedService {
 public:
  using EventCallback = std::function<void(const std::string& event_name,
                                           const std::string& params_json)>;
  using PageDetachHook = std::function<void(const std::string& page_id)>;

  explicit AgentSpaceManager(Profile* owner_profile);
  AgentSpaceManager(const AgentSpaceManager&) = delete;
  AgentSpaceManager& operator=(const AgentSpaceManager&) = delete;
  ~AgentSpaceManager() override;

  // KeyedService:
  void Shutdown() override;

  void SetEventCallback(EventCallback callback);
  void SetPageDetachHook(PageDetachHook hook);

  SpaceSnapshot CreateSpace(const std::string& name,
                            AuthMode auth_mode,
                            const gfx::Size& default_viewport = {1280, 800});
  KernelOpResult CloseSpace(const std::string& space_id);
  std::optional<SpaceSnapshot> GetSpace(const std::string& space_id) const;
  std::vector<SpaceSnapshot> ListSpaces() const;

  // Creates a detached WebContents (initially_hidden=true, foreground scheduler
  // boost enabled via OnBoostForBackgroundExecutionAdded, non-zero viewport).
  KernelOpResult OpenPage(const std::string& space_id,
                          const std::string& url,
                          std::optional<gfx::Size> viewport,
                          PageSnapshot* out_page);
  KernelOpResult ClosePage(const std::string& page_id);
  std::optional<PageSnapshot> GetPage(const std::string& page_id) const;
  std::vector<PageSnapshot> ListPages(
      const std::optional<std::string>& space_id = std::nullopt) const;

  // Called by AgentWebContentsDelegate when a page triggers window.open/_blank
  // or window.close(). Keeps popups 100% captured inside the owning AgentSpace.
  content::WebContents* CapturePopupWebContents(
      content::WebContents* source,
      std::unique_ptr<content::WebContents> new_contents,
      const std::string& target_url);
  void CloseWebContents(content::WebContents* web_contents);

  // Hot-mount / unmount into the expandable AgentSpaceWindow WebView.
  KernelOpResult AttachView(const std::string& page_id,
                            bool interactive,
                            PageSnapshot* out_page,
                            ControlState* out_state);
  KernelOpResult DetachView(const std::string& page_id,
                            PageSnapshot* out_page,
                            ControlState* out_state);

  // Explicit control handoff (also triggered automatically on direct user input).
  KernelOpResult RequestTakeover(const std::string& space_id,
                                 const std::optional<std::string>& page_id,
                                 const std::string& reason);
  KernelOpResult ReleaseTakeover(const std::string& space_id);

  // Non-blocking JS dialog governance (survives client disconnects/reconnects).
  void NotifyDialogOpened(content::WebContents* web_contents,
                          const PendingDialogInfo& info);
  KernelOpResult HandleDialog(const std::string& page_id,
                              bool accept,
                              const std::optional<std::string>& prompt_text,
                              std::string* out_dialog_type);
  std::vector<std::pair<std::string, PendingDialogInfo>> ListOpenDialogs()
      const;

  // Native desktop tab bridge (lets AI pages run directly as native browser
  // tabs with tab-level optical glow, and lets users hand existing tabs to AI).
  static void SetNativeTabHostHooks(NativeTabHostHooks hooks);
  static TabAiState GetWebContentsAiState(
      const content::WebContents* web_contents);
  static uint64_t GetAiTabStateGeneration();

  KernelOpResult AttachNativeTab(const std::string& space_id,
                                 content::WebContents* web_contents,
                                 PageSnapshot* out_page);
  KernelOpResult DetachNativeTab(content::WebContents* web_contents);
  KernelOpResult DetachNativeTabByPageId(const std::string& page_id);
  void OnNativeTabDestroyed(const std::string& page_id);
  std::vector<NativeTabInfo> ListNativeTabs() const;
  content::WebContents* GetActiveNativeTab() const;
  bool FocusNativeTabByIndex(int tab_index);
  bool FocusNativeTabByPageId(const std::string& page_id);
  bool FocusNextAiNativeTab();

  // Enforces ERR_TARGET_OUT_OF_SCOPE, ERR_HUMAN_IN_CONTROL, and
  // ERR_TUNNEL_DISCONNECTED_FAIL_CLOSED prior to CDP or mutating page actions.
  KernelOpResult AuthorizeAgentMutation(const std::string& page_id) const;

  // Strict scope check used by AgentCdpBridge to block personal tab inspection.
  bool IsAgentOwnedWebContents(const content::WebContents* web_contents) const;
  content::WebContents* GetWebContentsByPageId(
      const std::string& page_id) const;
  std::optional<std::string> FindPageIdByWebContents(
      const content::WebContents* web_contents) const;
  std::optional<std::string> GetSpaceIdForPage(
      const std::string& page_id) const;
  std::string GetPageUrl(const std::string& page_id) const;
  bool IsPasswordInputFocused(const std::string& page_id) const;

 private:
  void UpdateKeepAlives();
  void SyncGlobalAiTabStates();
  PageSnapshot BuildPageSnapshot(const AgentPageRecord& page) const;
  void EmitEvent(const std::string& event_name,
                 const std::string& params_json) const;

  raw_ptr<Profile> owner_profile_;
  std::unique_ptr<AgentWebContentsDelegate> web_contents_delegate_;
  std::map<std::string, std::unique_ptr<AgentSpaceRecord>> spaces_;
  std::map<std::string, std::unique_ptr<AgentPageRecord>> pages_;
  std::unique_ptr<ScopedKeepAlive> keep_alive_;
  std::unique_ptr<ScopedProfileKeepAlive> profile_keep_alive_;
  EventCallback event_callback_;
  PageDetachHook page_detach_hook_;
  uint64_t next_space_seq_ = 1;
  uint64_t next_page_seq_ = 1;
  size_t next_focus_ai_cursor_ = 0;
};

class AgentSpaceManagerFactory : public ProfileKeyedServiceFactory {
 public:
  static AgentSpaceManager* GetForProfile(Profile* profile);
  static AgentSpaceManagerFactory* GetInstance();

 private:
  friend base::NoDestructor<AgentSpaceManagerFactory>;
  AgentSpaceManagerFactory();
  ~AgentSpaceManagerFactory() override;

  std::unique_ptr<KeyedService> BuildServiceInstanceForBrowserContext(
      content::BrowserContext* context) const override;
};

const char* AuthModeToString(AuthMode mode);
const char* ControlStateToString(ControlState state);

}  // namespace agent_kernel

#endif  // CHROME_BROWSER_AGENT_KERNEL_AGENT_SPACE_MANAGER_H_
