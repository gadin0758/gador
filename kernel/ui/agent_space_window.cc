#include "chrome/browser/agent_kernel/ui/agent_space_window.h"

#include <memory>
#include <utility>

#include "chrome/browser/profiles/profile.h"
#include "content/public/browser/web_contents.h"
#include "ui/events/event.h"
#include "ui/views/layout/fill_layout.h"

namespace agent_kernel::ui {

AgentSpaceWindow::AgentSpaceWindow(Profile* profile,
                                   InteractionCallback on_user_interacted,
                                   base::RepeatingClosure on_collapse_requested)
    : on_user_interacted_(std::move(on_user_interacted)),
      on_collapse_requested_(std::move(on_collapse_requested)) {
  SetLayoutManager(std::make_unique<views::FillLayout>());
  web_view_ = AddChildView(std::make_unique<views::WebView>(profile));
}

AgentSpaceWindow::~AgentSpaceWindow() {
  // Always detach before destruction so WebView never tears down an Agent-owned
  // WebContents when the dedicated view is collapsed or closed.
  DetachWebContents();
}

void AgentSpaceWindow::AttachWebContents(const std::string& page_id,
                                         content::WebContents* web_contents) {
  if (!web_view_) {
    return;
  }
  mounted_page_id_ = page_id;
  web_view_->SetWebContents(web_contents);
}

void AgentSpaceWindow::DetachWebContents() {
  if (web_view_) {
    web_view_->SetWebContents(nullptr);
  }
  mounted_page_id_.clear();
}

void AgentSpaceWindow::OnMouseEvent(::ui::MouseEvent* event) {
  if (event && event->type() == ::ui::EventType::kMousePressed) {
    NotifyDirectUserInteraction();
  }
  views::View::OnMouseEvent(event);
}

void AgentSpaceWindow::OnKeyEvent(::ui::KeyEvent* event) {
  if (event && event->type() == ::ui::EventType::kKeyPressed) {
    NotifyDirectUserInteraction();
  }
  views::View::OnKeyEvent(event);
}

void AgentSpaceWindow::NotifyDirectUserInteraction() {
  if (!mounted_page_id_.empty() && on_user_interacted_) {
    on_user_interacted_.Run(mounted_page_id_);
  }
}

}  // namespace agent_kernel::ui
