#include "chrome/browser/agent_kernel/agent_offscreen_host.h"

#include <optional>
#include <string>

#include "base/containers/flat_map.h"
#include "base/containers/flat_set.h"
#include "content/public/browser/web_contents.h"
#include "ui/gfx/geometry/rect.h"

#if defined(USE_AURA)
#include "base/memory/raw_ptr.h"
#include "ui/aura/client/window_parenting_client.h"
#include "ui/aura/window.h"
#include "ui/aura/window_tree_host.h"
#include "ui/base/ime/input_method_minimal.h"
#include "ui/events/keycodes/dom/dom_code.h"
#endif

namespace agent_kernel {

#if defined(USE_AURA)

namespace {

class OffscreenWindowParentingClient final
    : public aura::client::WindowParentingClient {
 public:
  explicit OffscreenWindowParentingClient(aura::Window* root_window)
      : root_window_(root_window) {
    aura::client::SetWindowParentingClient(root_window_, this);
  }
  OffscreenWindowParentingClient(const OffscreenWindowParentingClient&) =
      delete;
  OffscreenWindowParentingClient& operator=(
      const OffscreenWindowParentingClient&) = delete;
  ~OffscreenWindowParentingClient() override {
    aura::client::SetWindowParentingClient(root_window_, nullptr);
  }

  aura::Window* GetDefaultParent(aura::Window* /*window*/,
                                 const gfx::Rect& /*bounds*/,
                                 const int64_t /*display_id*/) override {
    return root_window_;
  }

 private:
  raw_ptr<aura::Window> root_window_;
};

}  // namespace

class AgentOffscreenHost::Impl final : public aura::WindowTreeHost {
 public:
  explicit Impl(const gfx::Size& initial_viewport) {
    input_method_ = std::make_unique<ui::InputMethodMinimal>(this);
    SetSharedInputMethod(input_method_.get());
    CreateCompositor(/*use_external_begin_frame_control=*/false);
    OnAcceleratedWidgetAvailable();
    InitHost();
    window_parenting_client_ =
        std::make_unique<OffscreenWindowParentingClient>(window());
    window()->Show();
    SetBoundsInPixels(gfx::Rect(NormalizeSize(initial_viewport)));
    Show();
  }

  Impl(const Impl&) = delete;
  Impl& operator=(const Impl&) = delete;

  ~Impl() override {
    window_parenting_client_.reset();
    DestroyCompositor();
    DestroyDispatcher();
    SetSharedInputMethod(nullptr);
    input_method_.reset();
  }

  void Adopt(content::WebContents* web_contents, const gfx::Size& viewport) {
    if (!web_contents) {
      return;
    }
    const gfx::Rect bounds(NormalizeSize(viewport));
    if (aura::Window* native_view = web_contents->GetNativeView()) {
      if (native_view->parent() != window()) {
        window()->AddChild(native_view);
      }
      native_view->Show();
      native_view->SetBounds(bounds);
    }
    Show();
    SetBoundsInPixels(bounds);
    web_contents->UpdateWebContentsVisibility(content::Visibility::VISIBLE);
  }

  void ResizeViewport(const gfx::Size& viewport) {
    SetBoundsInPixels(gfx::Rect(NormalizeSize(viewport)));
  }

  // aura::WindowTreeHost overrides:
  ui::EventSource* GetEventSource() override { return this; }
  gfx::AcceleratedWidget GetAcceleratedWidget() override {
    return gfx::kNullAcceleratedWidget;
  }
  gfx::Rect GetBoundsInPixels() const override { return bounds_; }
  void SetBoundsInPixels(const gfx::Rect& bounds) override {
    window()->SetBounds(bounds);
    if (bounds_ != bounds) {
      const bool moved = bounds_.origin() != bounds.origin();
      bounds_ = bounds;
      if (moved) {
        auto weak = GetWeakPtr();
        OnHostMovedInPixels();
        if (!weak) {
          return;
        }
      }
      OnHostResizedInPixels(bounds.size());
    }
  }
  void ShowImpl() override {}
  void HideImpl() override {}
  gfx::Point GetLocationOnScreenInPixels() const override {
    return bounds_.origin();
  }
  void SetCapture() override {}
  void ReleaseCapture() override {}
  bool CaptureSystemKeyEventsImpl(
      std::optional<base::flat_set<ui::DomCode>> dom_codes) override {
    return false;
  }
  void ReleaseSystemKeyEventCapture() override {}
  bool IsKeyLocked(ui::DomCode dom_code) override { return false; }
  base::flat_map<std::string, std::string> GetKeyboardLayoutMap() override {
    return {};
  }
  void SetCursorNative(gfx::NativeCursor cursor) override {}
  void MoveCursorToScreenLocationInPixels(const gfx::Point& location) override {
  }
  void OnCursorVisibilityChangedNative(bool show) override {}

 private:
  static gfx::Size NormalizeSize(const gfx::Size& size) {
    return (size.width() > 0 && size.height() > 0) ? size : gfx::Size(1280, 800);
  }

  gfx::Rect bounds_;
  std::unique_ptr<ui::InputMethodMinimal> input_method_;
  std::unique_ptr<OffscreenWindowParentingClient> window_parenting_client_;
};

AgentOffscreenHost::AgentOffscreenHost(const gfx::Size& viewport)
    : impl_(std::make_unique<Impl>(viewport)) {}

AgentOffscreenHost::~AgentOffscreenHost() = default;

void AgentOffscreenHost::AdoptWebContents(content::WebContents* web_contents,
                                          const gfx::Size& viewport) {
  if (impl_) {
    impl_->Adopt(web_contents, viewport);
  }
}

void AgentOffscreenHost::Resize(const gfx::Size& viewport) {
  if (impl_) {
    impl_->ResizeViewport(viewport);
  }
}

#else

class AgentOffscreenHost::Impl {};

AgentOffscreenHost::AgentOffscreenHost(const gfx::Size& /*viewport*/) = default;
AgentOffscreenHost::~AgentOffscreenHost() = default;

void AgentOffscreenHost::AdoptWebContents(content::WebContents* /*web_contents*/,
                                          const gfx::Size& /*viewport*/) {}

void AgentOffscreenHost::Resize(const gfx::Size& /*viewport*/) {}

#endif

}  // namespace agent_kernel
