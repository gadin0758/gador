#include "chrome/browser/agent_kernel/ui/gador_toolbar_controls.h"

#include <cmath>
#include <string>
#include <unordered_map>
#include <utility>

#include "base/strings/utf_string_conversions.h"
#include "base/time/time.h"
#include "cc/paint/paint_flags.h"
#include "cc/paint/paint_shader.h"
#include "chrome/browser/agent_kernel/agent_space_manager.h"
#include "chrome/browser/agent_kernel/core/security_guard.h"
#include "chrome/browser/agent_kernel/ui/gador_native_ui_config.h"
#include "chrome/browser/profiles/profile.h"
#include "content/public/browser/web_contents.h"
#include "third_party/skia/include/core/SkColor.h"
#include "third_party/skia/include/core/SkPoint.h"
#include "ui/base/metadata/metadata_impl_macros.h"
#include "ui/gfx/canvas.h"
#include "ui/gfx/font_list.h"
#include "ui/gfx/geometry/insets.h"
#include "ui/gfx/geometry/rect.h"
#include "ui/gfx/geometry/size.h"
#include "ui/views/controls/button/button.h"
#include "ui/views/layout/box_layout.h"

namespace agent_kernel::views_ui {

namespace {

// Compact native 28x28 circular/rounded icon button painted directly in Skia.
class GadorIconButton : public views::Button {
  METADATA_HEADER(GadorIconButton, views::Button)

 public:
  enum class Kind { kLayout, kIncognito, kSettingsR };

  GadorIconButton(Kind kind,
                  const std::u16string& tooltip,
                  base::RepeatingClosure on_click)
      : views::Button(base::BindRepeating(
            [](base::RepeatingClosure cb, const ::ui::Event&) {
              if (cb) {
                cb.Run();
              }
            },
            std::move(on_click))),
        kind_(kind) {
    SetTooltipText(tooltip);
    SetPreferredSize(gfx::Size(28, 28));
    SetFocusBehavior(FocusBehavior::ACCESSIBLE_ONLY);
  }

  void PaintButtonContents(gfx::Canvas* canvas) override {
    const gfx::RectF bounds(GetLocalBounds());
    const bool hovered = GetState() == STATE_HOVERED || GetState() == STATE_PRESSED;

    // Subtle luminous pill backdrop
    cc::PaintFlags bg;
    bg.setAntiAlias(true);
    if (kind_ == Kind::kSettingsR) {
      const SkPoint pts[2] = {SkPoint::Make(0, 0),
                              SkPoint::Make(bounds.width(), bounds.height())};
      const SkColor4f colors[2] = {
          SkColor4f{0.31f, 0.55f, 1.0f, hovered ? 1.0f : 0.90f},
          SkColor4f{0.55f, 0.36f, 0.96f, hovered ? 1.0f : 0.90f}};
      const SkScalar pos[2] = {0.0f, 1.0f};
      bg.setShader(cc::PaintShader::MakeLinearGradient(
          pts, colors, pos, 2, SkTileMode::kClamp));
      canvas->DrawRoundRect(gfx::RectF(3, 3, 22, 22), 7.0f, bg);

      // Luminous capital "R"
      gfx::FontList font("Inter, Sans, 13px");
      canvas->DrawStringRectWithFlags(
          u"R", font.DeriveWithWeight(gfx::Font::Weight::BOLD), SK_ColorWHITE,
          gfx::Rect(3, 3, 22, 22),
          gfx::Canvas::TEXT_ALIGN_CENTER | gfx::Canvas::NO_SUBPIXEL_RENDERING);
      return;
    }

    if (hovered) {
      bg.setColor(kind_ == Kind::kIncognito
                      ? SkColorSetARGB(55, 176, 97, 255)
                      : SkColorSetARGB(45, 125, 152, 255));
      canvas->DrawRoundRect(gfx::RectF(1, 1, 26, 26), 13.0f, bg);
    }

    cc::PaintFlags stroke;
    stroke.setAntiAlias(true);
    stroke.setStyle(cc::PaintFlags::kStroke_Style);
    stroke.setStrokeWidth(1.6f);
    stroke.setStrokeCap(cc::PaintFlags::kRound_Cap);
    stroke.setStrokeJoin(cc::PaintFlags::kRound_Join);
    stroke.setColor(hovered ? SkColorSetARGB(255, 220, 230, 255)
                            : SkColorSetARGB(215, 160, 174, 204));

    if (kind_ == Kind::kLayout) {
      // Zen sidebar / layout toggle wireframe
      canvas->DrawRoundRect(gfx::RectF(6, 7, 16, 14), 3.0f, stroke);
      canvas->DrawLine(gfx::PointF(11.5f, 7.0f), gfx::PointF(11.5f, 21.0f),
                       stroke);
    } else if (kind_ == Kind::kIncognito) {
      // Minimalist incognito hat + glasses icon
      canvas->DrawLine(gfx::PointF(5.5f, 13.0f), gfx::PointF(22.5f, 13.0f),
                       stroke);
      canvas->DrawLine(gfx::PointF(8.0f, 13.0f), gfx::PointF(10.0f, 7.5f),
                       stroke);
      canvas->DrawLine(gfx::PointF(10.0f, 7.5f), gfx::PointF(18.0f, 7.5f),
                       stroke);
      canvas->DrawLine(gfx::PointF(18.0f, 7.5f), gfx::PointF(20.0f, 13.0f),
                       stroke);
      canvas->DrawCircle(gfx::PointF(10.2f, 18.2f), 2.5f, stroke);
      canvas->DrawCircle(gfx::PointF(17.8f, 18.2f), 2.5f, stroke);
      canvas->DrawLine(gfx::PointF(12.7f, 18.2f), gfx::PointF(15.3f, 18.2f),
                       stroke);
    }
  }

 private:
  Kind kind_;
};

BEGIN_METADATA(GadorIconButton)
END_METADATA

}  // namespace

// Pearlescent white-to-periwinkle-blue concentric luminous halo pill for AI
// running status inside Chromium's native ToolbarView.
class GadorAiBeaconPill : public views::Button {
  METADATA_HEADER(GadorAiBeaconPill, views::Button)

 public:
  explicit GadorAiBeaconPill(base::RepeatingClosure on_click)
      : views::Button(base::BindRepeating(
            [](base::RepeatingClosure cb, const ::ui::Event&) {
              if (cb) {
                cb.Run();
              }
            },
            std::move(on_click))) {
    SetTooltipText(u"查看 AI 正在运行的独立空间");
    SetFocusBehavior(FocusBehavior::ACCESSIBLE_ONLY);
    SetVisible(false);
  }

  ~GadorAiBeaconPill() override { anim_timer_.Stop(); }

  void Update(bool active, bool paused, size_t count) {
    active_ = active;
    paused_ = paused;
    count_ = count;
    SetVisible(active_);

    if (!active_ || paused_) {
      anim_timer_.Stop();
    } else if (!anim_timer_.IsRunning()) {
      anim_timer_.Start(FROM_HERE, base::Milliseconds(33),
                        base::BindRepeating(&GadorAiBeaconPill::OnTick,
                                            base::Unretained(this)));
    }
    PreferredSizeChanged();
    SchedulePaint();
  }

  gfx::Size CalculatePreferredSize(
      const views::SizeBounds& available_size) const override {
    return active_ ? gfx::Size(116, 28) : gfx::Size(0, 0);
  }

  void PaintButtonContents(gfx::Canvas* canvas) override {
    if (!active_) {
      return;
    }
    const gfx::RectF bounds(GetLocalBounds());
    const bool hovered = GetState() == STATE_HOVERED || GetState() == STATE_PRESSED;

    // Pill surface
    cc::PaintFlags pill;
    pill.setAntiAlias(true);
    pill.setColor(paused_ ? SkColorSetARGB(hovered ? 78 : 54, 255, 181, 71)
                          : SkColorSetARGB(hovered ? 82 : 56, 125, 152, 255));
    canvas->DrawRoundRect(gfx::RectF(1, 2, bounds.width() - 2, 24), 12.0f,
                          pill);

    cc::PaintFlags border;
    border.setAntiAlias(true);
    border.setStyle(cc::PaintFlags::kStroke_Style);
    border.setStrokeWidth(1.0f);
    border.setColor(paused_ ? SkColorSetARGB(150, 255, 181, 71)
                            : SkColorSetARGB(160, 138, 162, 255));
    canvas->DrawRoundRect(gfx::RectF(1, 2, bounds.width() - 2, 24), 12.0f,
                          border);

    // Concentric luminous halo beacon (pearlescent white core -> periwinkle blue)
    const SkPoint center = SkPoint::Make(15.0f, 14.0f);
    const float wave = paused_
                           ? 0.5f
                           : 0.5f + 0.5f * static_cast<float>(std::sin(phase_));

    // Diffuse outer aura
    {
      const SkColor4f c_in =
          paused_ ? SkColor4f{1.0f, 0.71f, 0.28f, 0.42f}
                  : SkColor4f{0.49f, 0.60f, 1.0f, 0.44f + 0.16f * wave};
      const SkColor4f c_out = SkColor4f{c_in.fR, c_in.fG, c_in.fB, 0.0f};
      const SkColor4f colors[2] = {c_in, c_out};
      const SkScalar pos[2] = {0.0f, 1.0f};
      cc::PaintFlags aura;
      aura.setAntiAlias(true);
      aura.setShader(cc::PaintShader::MakeRadialGradient(
          center, 9.0f + 2.2f * wave, colors, pos, 2, SkTileMode::kClamp));
      canvas->DrawCircle(gfx::PointF(center.fX, center.fY), 11.5f, aura);
    }

    // Concentric expanding delicate ring
    if (!paused_) {
      cc::PaintFlags ring;
      ring.setAntiAlias(true);
      ring.setStyle(cc::PaintFlags::kStroke_Style);
      ring.setStrokeWidth(1.0f);
      ring.setColor(
          SkColorSetARGB(static_cast<U8CPU>(155 * (1.0f - wave)), 162, 182, 255));
      canvas->DrawCircle(gfx::PointF(center.fX, center.fY), 5.5f + 5.0f * wave,
                         ring);
    }

    // Pearlescent white-centered glowing core orb
    {
      const SkColor4f colors[3] = {
          SkColor4f{1.0f, 1.0f, 1.0f, 1.0f},
          paused_ ? SkColor4f{1.0f, 0.90f, 0.68f, 1.0f}
                  : SkColor4f{0.86f, 0.90f, 1.0f, 1.0f},
          paused_ ? SkColor4f{1.0f, 0.71f, 0.28f, 1.0f}
                  : SkColor4f{0.44f, 0.56f, 1.0f, 1.0f}};
      const SkScalar pos[3] = {0.0f, 0.42f, 1.0f};
      cc::PaintFlags core;
      core.setAntiAlias(true);
      core.setShader(cc::PaintShader::MakeRadialGradient(
          center, 4.4f, colors, pos, 3, SkTileMode::kClamp));
      canvas->DrawCircle(gfx::PointF(center.fX, center.fY), 4.4f, core);
    }

    const std::u16string text =
        paused_
            ? base::UTF8ToUTF16("已停止 (" + std::to_string(count_) + ")")
            : base::UTF8ToUTF16("AI 运行 (" + std::to_string(count_) + ")");
    gfx::FontList font("Inter, Noto Sans CJK SC, Sans, 12px");
    canvas->DrawStringRectWithFlags(
        text, font.DeriveWithWeight(gfx::Font::Weight::MEDIUM),
        paused_ ? SkColorSetRGB(255, 212, 138) : SkColorSetRGB(224, 232, 255),
        gfx::Rect(27, 2, bounds.width() - 32, 24),
        gfx::Canvas::TEXT_ALIGN_LEFT | gfx::Canvas::NO_SUBPIXEL_RENDERING);
  }

 private:
  void OnTick() {
    phase_ += 0.095;
    if (phase_ > 6.28318530718) {
      phase_ -= 6.28318530718;
    }
    SchedulePaint();
  }

  bool active_ = false;
  bool paused_ = false;
  size_t count_ = 0;
  double phase_ = 0.0;
  base::RepeatingTimer anim_timer_;
};

BEGIN_METADATA(GadorAiBeaconPill)
END_METADATA

// Immediate Stop-AI / Resume-AI pill button mounted directly in ToolbarView.
class GadorStopAiButton : public views::Button {
  METADATA_HEADER(GadorStopAiButton, views::Button)

 public:
  explicit GadorStopAiButton(base::RepeatingClosure on_click)
      : views::Button(base::BindRepeating(
            [](base::RepeatingClosure cb, const ::ui::Event&) {
              if (cb) {
                cb.Run();
              }
            },
            std::move(on_click))) {
    SetTooltipText(u"立即停止 / 恢复 AI 操作");
    SetFocusBehavior(FocusBehavior::ACCESSIBLE_ONLY);
    SetVisible(false);
  }

  void Update(bool active, bool paused) {
    active_ = active;
    paused_ = paused;
    SetVisible(active_);
    SetTooltipText(paused_ ? u"恢复 AI 继续运行" : u"立即停止 AI 操作并冻结写入");
    PreferredSizeChanged();
    SchedulePaint();
  }

  gfx::Size CalculatePreferredSize(
      const views::SizeBounds& available_size) const override {
    return active_ ? gfx::Size(64, 28) : gfx::Size(0, 0);
  }

  void PaintButtonContents(gfx::Canvas* canvas) override {
    if (!active_) {
      return;
    }
    const gfx::RectF bounds(GetLocalBounds());
    const bool hovered = GetState() == STATE_HOVERED || GetState() == STATE_PRESSED;

    cc::PaintFlags bg;
    bg.setAntiAlias(true);
    bg.setColor(paused_ ? SkColorSetARGB(hovered ? 92 : 64, 125, 152, 255)
                        : SkColorSetARGB(hovered ? 110 : 76, 255, 93, 115));
    canvas->DrawRoundRect(gfx::RectF(1, 2, bounds.width() - 2, 24), 12.0f, bg);

    cc::PaintFlags border;
    border.setAntiAlias(true);
    border.setStyle(cc::PaintFlags::kStroke_Style);
    border.setStrokeWidth(1.0f);
    border.setColor(paused_ ? SkColorSetARGB(160, 125, 152, 255)
                            : SkColorSetARGB(180, 255, 93, 115));
    canvas->DrawRoundRect(gfx::RectF(1, 2, bounds.width() - 2, 24), 12.0f,
                          border);

    const std::u16string label = paused_ ? u"▶ 恢复" : u"■ 停止";
    gfx::FontList font("Inter, Noto Sans CJK SC, Sans, 11px");
    canvas->DrawStringRectWithFlags(
        label, font.DeriveWithWeight(gfx::Font::Weight::SEMIBOLD),
        paused_ ? SkColorSetRGB(224, 232, 255) : SkColorSetRGB(255, 152, 168),
        gfx::Rect(2, 2, bounds.width() - 4, 24),
        gfx::Canvas::TEXT_ALIGN_CENTER | gfx::Canvas::NO_SUBPIXEL_RENDERING);
  }

 private:
  bool active_ = false;
  bool paused_ = false;
};

BEGIN_METADATA(GadorStopAiButton)
END_METADATA

// Compact one-click "交给 AI / 收回" pill allowing the user to hand any
// already-open webpage directly to AI (or reclaim it without closing).
class GadorHandoverButton : public views::Button {
  METADATA_HEADER(GadorHandoverButton, views::Button)

 public:
  explicit GadorHandoverButton(base::RepeatingClosure on_click)
      : views::Button(base::BindRepeating(
            [](base::RepeatingClosure cb, const ::ui::Event&) {
              if (cb) {
                cb.Run();
              }
            },
            std::move(on_click))) {
    SetTooltipText(u"将当前网页交给 AI 操作");
    SetFocusBehavior(FocusBehavior::ACCESSIBLE_ONLY);
    SetVisible(false);
  }

  void Update(bool eligible, bool is_ai_tab) {
    eligible_ = eligible;
    is_ai_tab_ = is_ai_tab;
    SetVisible(eligible_);
    SetTooltipText(is_ai_tab_ ? u"从 AI 收回当前网页（保留页面不关闭）"
                              : u"将当前已有网页直接交给 AI 操作");
    PreferredSizeChanged();
    SchedulePaint();
  }

  gfx::Size CalculatePreferredSize(
      const views::SizeBounds& available_size) const override {
    return eligible_ ? gfx::Size(64, 28) : gfx::Size(0, 0);
  }

  void PaintButtonContents(gfx::Canvas* canvas) override {
    if (!eligible_) {
      return;
    }
    const gfx::RectF bounds(GetLocalBounds());
    const bool hovered =
        GetState() == STATE_HOVERED || GetState() == STATE_PRESSED;

    cc::PaintFlags bg;
    bg.setAntiAlias(true);
    bg.setColor(is_ai_tab_
                    ? SkColorSetARGB(hovered ? 96 : 64, 125, 152, 255)
                    : SkColorSetARGB(hovered ? 56 : 26, 125, 152, 255));
    canvas->DrawRoundRect(gfx::RectF(1, 2, bounds.width() - 2, 24), 12.0f, bg);

    cc::PaintFlags border;
    border.setAntiAlias(true);
    border.setStyle(cc::PaintFlags::kStroke_Style);
    border.setStrokeWidth(1.0f);
    border.setColor(is_ai_tab_ ? SkColorSetARGB(175, 125, 152, 255)
                               : SkColorSetARGB(hovered ? 130 : 80, 125, 152, 255));
    canvas->DrawRoundRect(gfx::RectF(1, 2, bounds.width() - 2, 24), 12.0f,
                          border);

    const std::u16string label = is_ai_tab_ ? u"收回 AI" : u"交给 AI";
    gfx::FontList font("Inter, Noto Sans CJK SC, Sans, 11px");
    canvas->DrawStringRectWithFlags(
        label, font.DeriveWithWeight(gfx::Font::Weight::MEDIUM),
        is_ai_tab_ ? SkColorSetRGB(125, 152, 255)
                   : SkColorSetRGB(115, 134, 178),
        gfx::Rect(2, 2, bounds.width() - 4, 24),
        gfx::Canvas::TEXT_ALIGN_CENTER | gfx::Canvas::NO_SUBPIXEL_RENDERING);
  }

 private:
  bool eligible_ = false;
  bool is_ai_tab_ = false;
};

BEGIN_METADATA(GadorHandoverButton)
END_METADATA

GadorToolbarControls::Callbacks::Callbacks() = default;
GadorToolbarControls::Callbacks::Callbacks(Callbacks&&) = default;
GadorToolbarControls::Callbacks& GadorToolbarControls::Callbacks::operator=(
    Callbacks&&) = default;
GadorToolbarControls::Callbacks::~Callbacks() = default;

GadorToolbarControls::GadorToolbarControls(Profile* profile,
                                           Callbacks callbacks)
    : profile_(profile ? profile->GetOriginalProfile() : nullptr),
      callbacks_(std::move(callbacks)) {
  auto* layout = SetLayoutManager(std::make_unique<views::BoxLayout>(
      views::BoxLayout::Orientation::kHorizontal, gfx::Insets::VH(0, 4), 4));
  layout->set_cross_axis_alignment(
      views::BoxLayout::CrossAxisAlignment::kCenter);

  ai_beacon_pill_ = AddChildView(
      std::make_unique<GadorAiBeaconPill>(callbacks_.on_open_ai_space));
  stop_ai_button_ = AddChildView(std::make_unique<GadorStopAiButton>(
      base::BindRepeating(&GadorToolbarControls::OnStopOrResumeAi,
                          base::Unretained(this))));
  handover_button_ = AddChildView(std::make_unique<GadorHandoverButton>(
      callbacks_.on_toggle_handover_active_tab));

  const auto& ui_cfg = GadorNativeUiConfig::GetInstance()->Get();
  // Native Zen vertical sidebar <-> Chrome top bar layout switcher
  if (ui_cfg.show_layout_toggle) {
    AddChildView(std::make_unique<GadorIconButton>(
        GadorIconButton::Kind::kLayout, u"切换竖向侧边栏 / 顶部标签栏",
        callbacks_.on_toggle_vertical_tabs));
  }

  // Compact native Incognito (隐私窗口) button
  if (ui_cfg.show_incognito_button) {
    AddChildView(std::make_unique<GadorIconButton>(
        GadorIconButton::Kind::kIncognito, u"打开隐私窗口（无痕）",
        callbacks_.on_open_incognito));
  }

  // Optional R shortcut (default false since Gador settings are fused into
  // native chrome://settings — avoids duplicate button next to User Avatar)
  if (ui_cfg.show_settings_button) {
    AddChildView(std::make_unique<GadorIconButton>(
        GadorIconButton::Kind::kSettingsR, u"Gador 设置",
        callbacks_.on_open_settings));
  }

  if (profile_) {
    poll_timer_.Start(FROM_HERE, base::Milliseconds(350),
                      base::BindRepeating(&GadorToolbarControls::PollAgentState,
                                          base::Unretained(this)));
  }
}

GadorToolbarControls::~GadorToolbarControls() {
  poll_timer_.Stop();
  ai_beacon_pill_ = nullptr;
  stop_ai_button_ = nullptr;
  handover_button_ = nullptr;
  profile_ = nullptr;
}

void GadorToolbarControls::PollAgentState() {
  if (!profile_) {
    return;
  }
  auto* manager = AgentSpaceManagerFactory::GetForProfile(profile_);
  if (!manager) {
    return;
  }
  const auto pages = manager->ListPages(std::nullopt);
  const size_t count = pages.size();
  const bool active = count > 0;

  bool any_running = false;
  if (active) {
    std::unordered_map<std::string, ControlState> states;
    for (const auto& sp : manager->ListSpaces()) {
      states[sp.space_id] = sp.control_state;
    }
    for (const auto& pg : pages) {
      auto it = states.find(pg.space_id);
      if (it == states.end() || it->second != ControlState::kUserActive) {
        any_running = true;
        break;
      }
    }
  }
  const bool paused = active && !any_running;

  bool next_tab_is_ai = false;
  bool next_tab_eligible = false;
  if (callbacks_.get_active_web_contents) {
    if (content::WebContents* wc = callbacks_.get_active_web_contents.Run()) {
      const auto st = AgentSpaceManager::GetWebContentsAiState(wc);
      next_tab_is_ai = (st != TabAiState::kNone);
      const GURL& url = wc->GetVisibleURL();
      const std::string spec = url.is_valid() ? url.spec() : "";
      next_tab_eligible =
          next_tab_is_ai ||
          (!spec.empty() && core::CheckAgentUrlPolicy(spec).Allowed() &&
           (url.SchemeIsHTTPOrHTTPS() || spec == "about:blank"));
    }
  }

  if (active != ai_active_ || paused != ai_paused_ ||
      count != active_page_count_ || next_tab_is_ai != active_tab_is_ai_ ||
      next_tab_eligible != active_tab_eligible_) {
    ai_active_ = active;
    ai_paused_ = paused;
    active_page_count_ = count;
    active_tab_is_ai_ = next_tab_is_ai;
    active_tab_eligible_ = next_tab_eligible;
    ai_beacon_pill_->Update(ai_active_, ai_paused_, active_page_count_);
    stop_ai_button_->Update(ai_active_, ai_paused_);
    if (handover_button_) {
      handover_button_->Update(active_tab_eligible_, active_tab_is_ai_);
    }
    PreferredSizeChanged();
  }
}

void GadorToolbarControls::OnStopOrResumeAi() {
  if (!profile_) {
    return;
  }
  auto* manager = AgentSpaceManagerFactory::GetForProfile(profile_);
  if (!manager) {
    return;
  }
  const auto spaces = manager->ListSpaces();
  if (ai_paused_) {
    for (const auto& sp : spaces) {
      if (sp.control_state == ControlState::kUserActive) {
        manager->ReleaseTakeover(sp.space_id);
      }
    }
  } else {
    for (const auto& sp : spaces) {
      if (sp.control_state != ControlState::kUserActive) {
        manager->RequestTakeover(sp.space_id, std::nullopt,
                                 "user_native_toolbar_stop");
      }
    }
  }
  PollAgentState();
}

BEGIN_METADATA(GadorToolbarControls)
END_METADATA

}  // namespace agent_kernel::views_ui
