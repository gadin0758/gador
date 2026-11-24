#ifndef CHROME_BROWSER_AGENT_KERNEL_UI_GADOR_NATIVE_UI_CONFIG_H_
#define CHROME_BROWSER_AGENT_KERNEL_UI_GADOR_NATIVE_UI_CONFIG_H_

#include <string>

#include "base/files/file_path.h"
#include "base/no_destructor.h"
#include "base/time/time.h"
#include "base/values.h"
#include "third_party/skia/include/core/SkColor.h"

namespace agent_kernel::views_ui {

// Hot-reloadable data-driven configuration for Gador's native C++ Views hooks
// (~/.config/gador/native-ui.json). Allows tuning branding, aura colors, glow
// depth/thickness, toolbar button visibility, and console URL at runtime with
// ZERO C++ recompilation.
struct GadorNativeUiSnapshot {
  std::string window_title_suffix = "Gador";
  std::string console_url = "http://127.0.0.1:43118";

  bool ai_aura_enabled = true;
  SkColor ai_aura_color = SkColorSetRGB(125, 152, 255);
  SkColor ai_paused_color = SkColorSetRGB(255, 181, 71);
  float ai_aura_thickness = 3.0f;
  float ai_aura_depth = 20.0f;
  float ai_aura_intensity = 1.0f;

  bool show_layout_toggle = true;
  bool show_incognito_button = true;
  bool show_settings_button = false;

  // Hot-reloadable native tab strip & chrome tone tuning (zero C++ recompile)
  std::string color_variant = "neutral";  // "neutral" | "tonal" | "vibrant"
  bool tab_active_accent_bar = true;
  float vertical_tab_corner_radius = 10.0f;
  SkColor tab_accent_color = SkColorSetRGB(125, 152, 255);
};

class GadorNativeUiConfig {
 public:
  static GadorNativeUiConfig* GetInstance();

  // Returns current snapshot, hot-reloading from disk if file mtime changed.
  const GadorNativeUiSnapshot& Get();

  // Updates fields from RPC dict and persists to ~/.config/gador/native-ui.json.
  void UpdateAndPersist(const base::DictValue& patch);

  // Resets native-ui.json back to clean defaults.
  void ResetDefaults();

  base::DictValue ToDict();
  base::FilePath config_path() const { return config_path_; }

  static bool ParseHexColor(const std::string& hex, SkColor* out);
  static std::string FormatHexColor(SkColor color);

 private:
  friend class base::NoDestructor<GadorNativeUiConfig>;
  GadorNativeUiConfig();
  void MaybeReloadFromDisk();
  void ApplyDict(const base::DictValue& dict);
  void SaveToDisk();

  base::FilePath config_path_;
  base::Time last_mtime_;
  base::TimeTicks last_check_;
  GadorNativeUiSnapshot snapshot_;
};

}  // namespace agent_kernel::views_ui

#endif  // CHROME_BROWSER_AGENT_KERNEL_UI_GADOR_NATIVE_UI_CONFIG_H_
