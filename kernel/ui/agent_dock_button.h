#ifndef CHROME_BROWSER_AGENT_KERNEL_UI_AGENT_DOCK_BUTTON_H_
#define CHROME_BROWSER_AGENT_KERNEL_UI_AGENT_DOCK_BUTTON_H_

#include <cstddef>

#include "base/functional/callback.h"
#include "base/memory/raw_ptr.h"
#include "ui/views/controls/button/label_button.h"

namespace agent_kernel::ui {

enum class DockBadgeState {
  kIdle,
  kRunning,
  kNeedsAttention,  // e.g. 2FA, CAPTCHA, or permission takeover requested
};

// Minimal unobtrusive corner/toolbar entry button shown while the dedicated
// Agent Space is collapsed. Clicking toggles AgentSpaceWindow visibility
// without touching personal browser tabs.
class AgentDockButton : public views::LabelButton {
 public:
  explicit AgentDockButton(base::RepeatingClosure on_toggle_space);
  AgentDockButton(const AgentDockButton&) = delete;
  AgentDockButton& operator=(const AgentDockButton&) = delete;
  ~AgentDockButton() override;

  void UpdateStatus(DockBadgeState state, size_t active_tasks);

 private:
  DockBadgeState state_ = DockBadgeState::kIdle;
  size_t active_tasks_ = 0;
};

}  // namespace agent_kernel::ui

#endif  // CHROME_BROWSER_AGENT_KERNEL_UI_AGENT_DOCK_BUTTON_H_
