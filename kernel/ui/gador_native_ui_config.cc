#include "chrome/browser/agent_kernel/ui/gador_native_ui_config.h"

#include <sys/stat.h>

#include <algorithm>
#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <sstream>

#include "base/json/json_reader.h"
#include "base/json/json_writer.h"
#include "base/no_destructor.h"
#include "base/strings/string_number_conversions.h"

namespace agent_kernel::views_ui {

namespace {

base::FilePath ResolveNativeUiConfigPath() {
  if (const char* xdg = std::getenv("XDG_CONFIG_HOME"); xdg && xdg[0] != '\0') {
    return base::FilePath(xdg).AppendASCII("gador").AppendASCII(
        "native-ui.json");
  }
  if (const char* home = std::getenv("HOME"); home && home[0] != '\0') {
    return base::FilePath(home)
        .AppendASCII(".config")
        .AppendASCII("gador")
        .AppendASCII("native-ui.json");
  }
  return base::FilePath("/tmp/gador-native-ui.json");
}

void EnsureParentDirs(const std::string& file_path) {
  size_t pos = file_path.find('/', 1);
  while (pos != std::string::npos) {
    std::string dir = file_path.substr(0, pos);
    ::mkdir(dir.c_str(), 0700);
    pos = file_path.find('/', pos + 1);
  }
}

bool GetFileMtime(const std::string& path, base::Time* out) {
  struct stat st {};
  if (::stat(path.c_str(), &st) != 0) {
    return false;
  }
  *out = base::Time::FromSecondsSinceUnixEpoch(
      static_cast<double>(st.st_mtim.tv_sec) +
      static_cast<double>(st.st_mtim.tv_nsec) / 1e9);
  return true;
}

}  // namespace

// static
GadorNativeUiConfig* GadorNativeUiConfig::GetInstance() {
  static base::NoDestructor<GadorNativeUiConfig> instance;
  return instance.get();
}

GadorNativeUiConfig::GadorNativeUiConfig()
    : config_path_(ResolveNativeUiConfigPath()) {
  MaybeReloadFromDisk();
}

// static
bool GadorNativeUiConfig::ParseHexColor(const std::string& hex, SkColor* out) {
  if (!out) {
    return false;
  }
  std::string s = hex;
  if (!s.empty() && s[0] == '#') {
    s.erase(0, 1);
  }
  if (s.size() != 6) {
    return false;
  }
  uint32_t rgb = 0;
  if (!base::HexStringToUInt(s, &rgb)) {
    return false;
  }
  *out = SkColorSetRGB((rgb >> 16) & 0xFF, (rgb >> 8) & 0xFF, rgb & 0xFF);
  return true;
}

// static
std::string GadorNativeUiConfig::FormatHexColor(SkColor color) {
  char buf[8];
  std::snprintf(buf, sizeof(buf), "#%02x%02x%02x", SkColorGetR(color),
                SkColorGetG(color), SkColorGetB(color));
  return std::string(buf);
}

const GadorNativeUiSnapshot& GadorNativeUiConfig::Get() {
  const base::TimeTicks now = base::TimeTicks::Now();
  if (last_check_.is_null() || (now - last_check_) >= base::Milliseconds(750)) {
    last_check_ = now;
    MaybeReloadFromDisk();
  }
  return snapshot_;
}

void GadorNativeUiConfig::MaybeReloadFromDisk() {
  base::Time mtime;
  if (!GetFileMtime(config_path_.value(), &mtime)) {
    return;
  }
  if (mtime == last_mtime_) {
    return;
  }
  last_mtime_ = mtime;

  std::ifstream ifs(config_path_.value(), std::ios::in | std::ios::binary);
  if (!ifs.is_open()) {
    return;
  }
  std::ostringstream oss;
  oss << ifs.rdbuf();
  auto parsed = base::JSONReader::ReadDict(oss.str(), base::JSON_PARSE_RFC);
  if (parsed.has_value()) {
    ApplyDict(*parsed);
  }
}

void GadorNativeUiConfig::ApplyDict(const base::DictValue& dict) {
  if (const std::string* s = dict.FindString("windowTitleSuffix");
      s && !s->empty()) {
    snapshot_.window_title_suffix = *s;
  }
  if (const std::string* s = dict.FindString("consoleUrl"); s && !s->empty()) {
    snapshot_.console_url = *s;
  }
  if (std::optional<bool> b = dict.FindBool("aiAuraEnabled"); b.has_value()) {
    snapshot_.ai_aura_enabled = *b;
  }
  if (const std::string* s = dict.FindString("aiAuraColor")) {
    SkColor c;
    if (ParseHexColor(*s, &c)) {
      snapshot_.ai_aura_color = c;
    }
  }
  if (const std::string* s = dict.FindString("aiPausedColor")) {
    SkColor c;
    if (ParseHexColor(*s, &c)) {
      snapshot_.ai_paused_color = c;
    }
  }
  if (std::optional<double> d = dict.FindDouble("aiAuraThickness");
      d.has_value()) {
    snapshot_.ai_aura_thickness =
        std::clamp(static_cast<float>(*d), 1.0f, 8.0f);
  }
  if (std::optional<double> d = dict.FindDouble("aiAuraDepth"); d.has_value()) {
    snapshot_.ai_aura_depth = std::clamp(static_cast<float>(*d), 6.0f, 64.0f);
  }
  if (std::optional<double> d = dict.FindDouble("aiAuraIntensity");
      d.has_value()) {
    snapshot_.ai_aura_intensity =
        std::clamp(static_cast<float>(*d), 0.2f, 2.0f);
  }
  if (std::optional<bool> b = dict.FindBool("showLayoutToggle");
      b.has_value()) {
    snapshot_.show_layout_toggle = *b;
  }
  if (std::optional<bool> b = dict.FindBool("showIncognitoButton");
      b.has_value()) {
    snapshot_.show_incognito_button = *b;
  }
  if (std::optional<bool> b = dict.FindBool("showSettingsButton");
      b.has_value()) {
    snapshot_.show_settings_button = *b;
  }
  if (const std::string* s = dict.FindString("colorVariant");
      s && (*s == "neutral" || *s == "tonal" || *s == "vibrant")) {
    snapshot_.color_variant = *s;
  }
  if (std::optional<bool> b = dict.FindBool("tabActiveAccentBar");
      b.has_value()) {
    snapshot_.tab_active_accent_bar = *b;
  }
  if (std::optional<double> d = dict.FindDouble("verticalTabCornerRadius");
      d.has_value()) {
    snapshot_.vertical_tab_corner_radius =
        std::clamp(static_cast<float>(*d), 4.0f, 16.0f);
  }
  if (const std::string* s = dict.FindString("tabAccentColor")) {
    SkColor c;
    if (ParseHexColor(*s, &c)) {
      snapshot_.tab_accent_color = c;
    }
  }
}

void GadorNativeUiConfig::UpdateAndPersist(const base::DictValue& patch) {
  ApplyDict(patch);
  SaveToDisk();
}

void GadorNativeUiConfig::ResetDefaults() {
  snapshot_ = GadorNativeUiSnapshot();
  SaveToDisk();
}

base::DictValue GadorNativeUiConfig::ToDict() {
  const auto& s = Get();
  base::DictValue d;
  d.Set("configPath", config_path_.value());
  d.Set("windowTitleSuffix", s.window_title_suffix);
  d.Set("consoleUrl", s.console_url);
  d.Set("aiAuraEnabled", s.ai_aura_enabled);
  d.Set("aiAuraColor", FormatHexColor(s.ai_aura_color));
  d.Set("aiPausedColor", FormatHexColor(s.ai_paused_color));
  d.Set("aiAuraThickness", static_cast<double>(s.ai_aura_thickness));
  d.Set("aiAuraDepth", static_cast<double>(s.ai_aura_depth));
  d.Set("aiAuraIntensity", static_cast<double>(s.ai_aura_intensity));
  d.Set("showLayoutToggle", s.show_layout_toggle);
  d.Set("showIncognitoButton", s.show_incognito_button);
  d.Set("showSettingsButton", s.show_settings_button);
  d.Set("colorVariant", s.color_variant);
  d.Set("tabActiveAccentBar", s.tab_active_accent_bar);
  d.Set("verticalTabCornerRadius",
        static_cast<double>(s.vertical_tab_corner_radius));
  d.Set("tabAccentColor", FormatHexColor(s.tab_accent_color));
  return d;
}

void GadorNativeUiConfig::SaveToDisk() {
  EnsureParentDirs(config_path_.value());
  auto json =
      base::WriteJsonWithOptions(ToDict(), base::OPTIONS_PRETTY_PRINT);
  if (json.has_value()) {
    std::ofstream ofs(config_path_.value(),
                      std::ios::out | std::ios::binary | std::ios::trunc);
    if (ofs.is_open()) {
      ofs << *json;
      ofs.close();
      ::chmod(config_path_.value().c_str(), 0600);
      GetFileMtime(config_path_.value(), &last_mtime_);
    }
  }
}

}  // namespace agent_kernel::views_ui
