#ifndef CHROME_BROWSER_AGENT_KERNEL_UI_GADOR_AI_AURA_OVERLAY_H_
#define CHROME_BROWSER_AGENT_KERNEL_UI_GADOR_AI_AURA_OVERLAY_H_

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

// Native C++ click-through Skia optical rim glow mounted directly inside
// BrowserView. Stays completely invisible during normal non-AI tabs;
// illuminates ONLY when the currently visible native tab is operated by AI
// (breathing periwinkle-blue while running, warm amber when paused/USER_ACTIVE).
class GadorAiAuraOverlay : public views::View {
  METADATA_HEADER(GadorAiAuraOverlay, views::View)

 public:
  using GetActiveWebContentsCallback =
      base::RepeatingCallback<content::WebContents*()>;

  GadorAiAuraOverlay(Profile* profile,
                     GetActiveWebContentsCallback get_active_wc,
                     base::RepeatingClosure on_ai_tabs_changed);
  GadorAiAuraOverlay(const GadorAiAuraOverlay&) = delete;
  GadorAiAuraOverlay& operator=(const GadorAiAuraOverlay&) = delete;
  ~GadorAiAuraOverlay() override;

  // views::View:
  void OnPaint(gfx::Canvas* canvas) override;

 private:
  void PollAgentState();
  void OnAnimationTick();

  raw_ptr<Profile> profile_ = nullptr;
  GetActiveWebContentsCallback get_active_wc_;
  base::RepeatingClosure on_ai_tabs_changed_;
  uint64_t last_ai_tab_generation_ = 0;
  bool ai_active_ = false;
  bool ai_paused_ = false;
  double pulse_phase_ = 0.0;

  base::RepeatingTimer poll_timer_;
  base::RepeatingTimer anim_timer_;
};

}  // namespace agent_kernel::views_ui

#endif  // CHROME_BROWSER_AGENT_KERNEL_UI_GADOR_AI_AURA_OVERLAY_H_
