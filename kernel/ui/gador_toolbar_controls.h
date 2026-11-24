#ifndef CHROME_BROWSER_AGENT_KERNEL_UI_GADOR_TOOLBAR_CONTROLS_H_
#define CHROME_BROWSER_AGENT_KERNEL_UI_GADOR_TOOLBAR_CONTROLS_H_

#include <cstddef>

#include "base/functional/callback.h"
#include "base/memory/raw_ptr.h"
#include "base/timer/timer.h"
#include "ui/base/metadata/metadata_header_macros.h"
#include "ui/views/view.h"

class Profile;

namespace content {
class WebContents;
}  // namespace content

namespace agent_kernel::views_ui {

class GadorAiBeaconPill;
class GadorStopAiButton;
class GadorHandoverButton;

// Native C++ toolbar control cluster embedded directly inside Chromium's
// ToolbarView (right next to Google Account Avatar & App Menu):
//  1. Pearlescent concentric luminous AI beacon pill (jumps directly to active AI native tab)
//  2. Immediate "■ 停止 / ▶ 恢复" button (freezes/resumes AI mutation)
//  3. One-click "交给 AI / 收回" handover pill for existing user tabs
//  4. Native Zen Vertical Sidebar <-> Chrome Top Bar toggle button
//  5. Compact native Incognito (隐私窗口) button right beside Settings
//  6. Compact luminous "R" Gador Settings (fused chrome://settings) button
class GadorToolbarControls : public views::View {
  METADATA_HEADER(GadorToolbarControls, views::View)

 public:
  struct Callbacks {
    Callbacks();
    Callbacks(Callbacks&&);
    Callbacks& operator=(Callbacks&&);
    ~Callbacks();

    base::RepeatingClosure on_open_ai_space;
    base::RepeatingCallback<content::WebContents*()> get_active_web_contents;
    base::RepeatingClosure on_toggle_handover_active_tab;
    base::RepeatingClosure on_toggle_vertical_tabs;
    base::RepeatingClosure on_open_incognito;
    base::RepeatingClosure on_open_settings;
  };

  GadorToolbarControls(Profile* profile, Callbacks callbacks);
  GadorToolbarControls(const GadorToolbarControls&) = delete;
  GadorToolbarControls& operator=(const GadorToolbarControls&) = delete;
  ~GadorToolbarControls() override;

 private:
  void PollAgentState();
  void OnStopOrResumeAi();

  raw_ptr<Profile> profile_ = nullptr;
  Callbacks callbacks_;

  raw_ptr<GadorAiBeaconPill> ai_beacon_pill_ = nullptr;
  raw_ptr<GadorStopAiButton> stop_ai_button_ = nullptr;
  raw_ptr<GadorHandoverButton> handover_button_ = nullptr;

  bool ai_active_ = false;
  bool ai_paused_ = false;
  size_t active_page_count_ = 0;
  bool active_tab_is_ai_ = false;
  bool active_tab_eligible_ = false;

  base::RepeatingTimer poll_timer_;
};

}  // namespace agent_kernel::views_ui

#endif  // CHROME_BROWSER_AGENT_KERNEL_UI_GADOR_TOOLBAR_CONTROLS_H_
