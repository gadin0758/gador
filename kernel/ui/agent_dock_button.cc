#include "chrome/browser/agent_kernel/ui/agent_dock_button.h"

#include <string>
#include <utility>

#include "base/strings/utf_string_conversions.h"

namespace agent_kernel::ui {

AgentDockButton::AgentDockButton(base::RepeatingClosure on_toggle_space)
    : views::LabelButton(
          base::BindRepeating(
              [](base::RepeatingClosure cb, const ::ui::Event&) {
                if (cb) {
                  cb.Run();
                }
              },
              std::move(on_toggle_space)),
          u"Agent") {
  UpdateStatus(DockBadgeState::kIdle, 0);
}

AgentDockButton::~AgentDockButton() = default;

void AgentDockButton::UpdateStatus(DockBadgeState state, size_t active_tasks) {
  state_ = state;
  active_tasks_ = active_tasks;

  switch (state_) {
    case DockBadgeState::kIdle:
      SetText(u"Agent");
      break;
    case DockBadgeState::kRunning:
      SetText(base::UTF8ToUTF16("Agent (" + std::to_string(active_tasks_) + ")"));
      break;
    case DockBadgeState::kNeedsAttention:
      SetText(base::UTF8ToUTF16("Agent ! (" + std::to_string(active_tasks_) + ")"));
      break;
  }
}

}  // namespace agent_kernel::ui
