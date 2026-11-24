#include "chrome/browser/agent_kernel/ui/gador_ai_aura_overlay.h"

#include <algorithm>
#include <cmath>
#include <unordered_map>

#include "base/time/time.h"
#include "cc/paint/paint_flags.h"
#include "cc/paint/paint_shader.h"
#include "chrome/browser/agent_kernel/agent_space_manager.h"
#include "chrome/browser/agent_kernel/ui/gador_native_ui_config.h"
#include "chrome/browser/profiles/profile.h"
#include "third_party/skia/include/core/SkColor.h"
#include "third_party/skia/include/core/SkPoint.h"
#include "ui/base/metadata/metadata_impl_macros.h"
#include "ui/compositor/layer.h"
#include "ui/gfx/canvas.h"
#include "ui/gfx/geometry/rect.h"

namespace agent_kernel::views_ui {

GadorAiAuraOverlay::GadorAiAuraOverlay(
    Profile* profile,
    GetActiveWebContentsCallback get_active_wc,
    base::RepeatingClosure on_ai_tabs_changed)
    : profile_(profile ? profile->GetOriginalProfile() : nullptr),
      get_active_wc_(std::move(get_active_wc)),
      on_ai_tabs_changed_(std::move(on_ai_tabs_changed)) {
  SetCanProcessEventsWithinSubtree(false);
  SetFocusBehavior(FocusBehavior::NEVER);
  SetPaintToLayer();
  layer()->SetFillsBoundsOpaquely(false);
  SetVisible(false);

  if (profile_) {
    poll_timer_.Start(FROM_HERE, base::Milliseconds(200),
                      base::BindRepeating(&GadorAiAuraOverlay::PollAgentState,
                                          base::Unretained(this)));
  }
}

GadorAiAuraOverlay::~GadorAiAuraOverlay() {
  anim_timer_.Stop();
  poll_timer_.Stop();
  profile_ = nullptr;
}

void GadorAiAuraOverlay::PollAgentState() {
  if (!profile_) {
    return;
  }

  // Trigger tab strip repaint immediately whenever any AI tab is attached,
  // detached, paused, or resumed so the tab-level lightfield stays in sync.
  const uint64_t gen = AgentSpaceManager::GetAiTabStateGeneration();
  if (gen != last_ai_tab_generation_) {
    last_ai_tab_generation_ = gen;
    if (on_ai_tabs_changed_) {
      on_ai_tabs_changed_.Run();
    }
  }

  content::WebContents* active_wc =
      get_active_wc_ ? get_active_wc_.Run() : nullptr;
  const TabAiState tab_state =
      AgentSpaceManager::GetWebContentsAiState(active_wc);

  if (tab_state == TabAiState::kNone) {
    if (ai_active_) {
      ai_active_ = false;
      ai_paused_ = false;
      anim_timer_.Stop();
      SetVisible(false);
    }
    return;
  }

  const bool next_paused = (tab_state == TabAiState::kPaused);
  const bool changed = (!ai_active_ || ai_paused_ != next_paused);
  ai_active_ = true;
  ai_paused_ = next_paused;
  SetVisible(true);

  if (ai_paused_) {
    anim_timer_.Stop();
  } else if (!anim_timer_.IsRunning()) {
    anim_timer_.Start(FROM_HERE, base::Milliseconds(33),
                      base::BindRepeating(&GadorAiAuraOverlay::OnAnimationTick,
                                          base::Unretained(this)));
  }
  if (changed) {
    SchedulePaint();
  }
}

void GadorAiAuraOverlay::OnAnimationTick() {
  pulse_phase_ += 0.085;
  if (pulse_phase_ > 6.28318530718) {
    pulse_phase_ -= 6.28318530718;
  }
  SchedulePaint();
}

void GadorAiAuraOverlay::OnPaint(gfx::Canvas* canvas) {
  if (!ai_active_) {
    return;
  }
  const auto& cfg = GadorNativeUiConfig::GetInstance()->Get();
  if (!cfg.ai_aura_enabled) {
    return;
  }
  const gfx::Rect bounds = GetLocalBounds();
  if (bounds.IsEmpty()) {
    return;
  }

  const float breathe = ai_paused_
                            ? 0.85f
                            : (0.70f + 0.30f * static_cast<float>(
                                                   std::sin(pulse_phase_)));
  const float intensity = std::clamp(cfg.ai_aura_intensity, 0.2f, 2.0f);
  const SkColor src = ai_paused_ ? cfg.ai_paused_color : cfg.ai_aura_color;
  const float r_f = static_cast<float>(SkColorGetR(src)) / 255.0f;
  const float g_f = static_cast<float>(SkColorGetG(src)) / 255.0f;
  const float b_f = static_cast<float>(SkColorGetB(src)) / 255.0f;

  const SkColor4f base_color = SkColor4f{
      r_f, g_f, b_f, std::min(0.65f, 0.30f * breathe * intensity)};
  const SkColor4f transparent = SkColor4f{r_f, g_f, b_f, 0.0f};
  const SkColor rim_color = SkColorSetARGB(
      static_cast<U8CPU>(std::min(245.0f, 175.0f * breathe * intensity)),
      SkColorGetR(src), SkColorGetG(src), SkColorGetB(src));

  const float glow_depth = cfg.ai_aura_depth;
  const float w = static_cast<float>(bounds.width());
  const float h = static_cast<float>(bounds.height());

  auto draw_edge_glow = [&](SkPoint p0, SkPoint p1, const gfx::Rect& r) {
    const SkPoint pts[2] = {p0, p1};
    const SkColor4f colors[2] = {base_color, transparent};
    const SkScalar pos[2] = {0.0f, 1.0f};
    cc::PaintFlags flags;
    flags.setAntiAlias(true);
    flags.setShader(cc::PaintShader::MakeLinearGradient(
        pts, colors, pos, 2, SkTileMode::kClamp));
    canvas->DrawRect(r, flags);
  };

  draw_edge_glow(SkPoint::Make(0, 0), SkPoint::Make(0, glow_depth),
                 gfx::Rect(0, 0, bounds.width(), static_cast<int>(glow_depth)));
  draw_edge_glow(
      SkPoint::Make(0, h), SkPoint::Make(0, h - glow_depth),
      gfx::Rect(0, bounds.height() - static_cast<int>(glow_depth),
                bounds.width(), static_cast<int>(glow_depth)));
  draw_edge_glow(SkPoint::Make(0, 0), SkPoint::Make(glow_depth, 0),
                 gfx::Rect(0, 0, static_cast<int>(glow_depth), bounds.height()));
  draw_edge_glow(
      SkPoint::Make(w, 0), SkPoint::Make(w - glow_depth, 0),
      gfx::Rect(bounds.width() - static_cast<int>(glow_depth), 0,
                static_cast<int>(glow_depth), bounds.height()));

  // Crisp inner luminous border
  cc::PaintFlags rim_flags;
  rim_flags.setAntiAlias(true);
  rim_flags.setStyle(cc::PaintFlags::kStroke_Style);
  rim_flags.setStrokeWidth(cfg.ai_aura_thickness);
  rim_flags.setColor(rim_color);
  canvas->DrawRect(gfx::RectF(bounds), rim_flags);
}

BEGIN_METADATA(GadorAiAuraOverlay)
END_METADATA

}  // namespace agent_kernel::views_ui
