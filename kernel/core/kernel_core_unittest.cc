#include <cassert>
#include <cstring>
#include <filesystem>
#include <iostream>
#include <string>
#include <vector>

#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <unistd.h>

#include "kernel/core/kernel_state.h"
#include "kernel/core/protocol_framing.h"
#include "kernel/core/rpc_router.h"
#include "kernel/core/security_guard.h"
#include "kernel/core/uds_posix_server.h"

namespace {

using namespace agent_kernel::core;

void TestFramingFragmentedAndCoalesced() {
  FrameDecoder decoder;
  auto f1 = EncodeFrame(R"({"id":1,"method":"agent.capabilities"})");
  auto f2 = EncodeFrame(R"({"id":2,"method":"space.create","params":{"name":"中文空间"}})");
  std::vector<uint8_t> combined;
  combined.insert(combined.end(), f1.begin(), f1.end());
  combined.insert(combined.end(), f2.begin(), f2.end());

  std::vector<std::string> decoded;
  for (size_t i = 0; i < combined.size(); i += 3) {
    size_t chunk = std::min<size_t>(3, combined.size() - i);
    auto res = decoder.Push(combined.data() + i, chunk);
    assert(res.ok);
    for (auto& s : res.frames) {
      decoded.push_back(std::move(s));
    }
  }
  assert(decoded.size() == 2);
  assert(decoded[0] == R"({"id":1,"method":"agent.capabilities"})");
  assert(decoded[1].find("中文空间") != std::string::npos);

  // Oversized frame header must fail cleanly.
  uint8_t bad_header[4] = {0xFF, 0x00, 0x00, 0x00};
  auto bad = decoder.Push(bad_header, sizeof(bad_header));
  assert(!bad.ok);
  std::cout << "[PASS] C++20 framing fragmented/coalesced + 64MiB guard\n";
}

void TestP0SpaceLifecycleHotMountTakeoverDialogs() {
  KernelState state;
  std::string shared = state.CreateSpace("work", AuthMode::kShared);
  std::string priv = state.CreateSpace("secret", AuthMode::kPrivate);

  // Reject zero viewport.
  PageInfo bad_page;
  auto zero_vp = state.OpenPage(shared, "https://example.com", Viewport{0, 0}, &bad_page);
  assert(!zero_vp.ok && zero_vp.error_code == "ERR_INVALID_PARAMS");

  PageInfo page;
  assert(state.OpenPage(shared, "https://example.com", std::nullopt, &page).ok);
  assert(page.viewport.width == 1280 && page.viewport.height == 800);
  assert(!page.view_attached);
  assert(!page.in_personal_tab_strip);

  // Out-of-scope target rejection (personal tab cannot be touched).
  auto oos = state.AuthorizeAgentMutation("personal_tab_1");
  assert(!oos.ok && oos.error_code == "ERR_TARGET_OUT_OF_SCOPE");

  // 50x hot attach/detach stress cycle.
  for (uint64_t i = 1; i <= 50; ++i) {
    PageInfo p_out;
    ControlState c_out;
    assert(state.AttachView(page.page_id, false, &p_out, &c_out).ok);
    assert(p_out.view_attached);
    assert(p_out.mount_count == i);
    assert(c_out == ControlState::kUserObserving);

    assert(state.DetachView(page.page_id, &p_out, &c_out).ok);
    assert(!p_out.view_attached);
    assert(c_out == ControlState::kAgentRunning);
  }

  // Active user takeover freezes Agent writes immediately.
  ControlState after_interactive;
  assert(state.AttachView(page.page_id, true, nullptr, &after_interactive).ok);
  assert(after_interactive == ControlState::kUserActive);

  auto blocked = state.AuthorizeAgentMutation(page.page_id);
  assert(!blocked.ok && blocked.error_code == "ERR_HUMAN_IN_CONTROL");

  assert(state.ReleaseTakeover(shared).ok);
  assert(state.AuthorizeAgentMutation(page.page_id).ok);

  // Popup capture stays inside owning AgentSpace.
  PageInfo popup;
  assert(state.CapturePopupPage(page.page_id, "https://example.com/pop", &popup).ok);
  assert(popup.space_id == shared);
  assert(!popup.in_personal_tab_strip);

  // Non-blocking JS dialog survives across client reconnects.
  assert(state.RecordDialogOpened(page.page_id, {"prompt", "enter code", "123", page.url}).ok);
  auto open_dialogs = state.ListOpenDialogs();
  assert(open_dialogs.size() == 1 && open_dialogs[0].first == page.page_id);

  std::string handled_type;
  assert(state.HandleDialog(page.page_id, true, "999", &handled_type).ok);
  assert(handled_type == "prompt");
  assert(state.ListOpenDialogs().empty());

  std::vector<std::string> closed;
  assert(state.CloseSpace(shared, &closed).ok);
  assert(closed.size() == 2);
  assert(state.CloseSpace(priv).ok);
  std::cout << "[PASS] C++20 P0 space/50x-hot-mount/takeover/popup/dialog invariants\n";
}

void TestP1IndependentVpnAndFailClosed() {
  KernelState state;
  std::string shared = state.CreateSpace("s", AuthMode::kShared);
  std::string priv = state.CreateSpace("p", AuthMode::kPrivate);

  TunnelPolicy browser_vpn;
  browser_vpn.scope = "browser";
  browser_vpn.mode = RouteMode::kStrictTunnel;
  browser_vpn.endpoint = "socks5://127.0.0.1:10808";
  browser_vpn.doh_server = "https://dns.quad9.net/dns-query";
  browser_vpn.fail_closed = true;

  TunnelPolicy effective;
  assert(state.SetTunnelPolicy(browser_vpn, &effective).ok);
  assert(effective.os_proxy_disabled);
  assert(effective.webrtc_policy == "disable_non_proxied_udp");
  assert(KernelState::ComputeEffectiveProxyRule(effective) == "socks5://127.0.0.1:10808");

  // Shared space cannot override browser tunnel (prevents dual-IP risk).
  TunnelPolicy shared_override = browser_vpn;
  shared_override.scope = "space:" + shared;
  auto reject_shared = state.SetTunnelPolicy(shared_override);
  assert(!reject_shared.ok && reject_shared.error_code == "ERR_INVALID_PARAMS");

  // Private space CAN bind an independent tunnel.
  TunnelPolicy priv_override = browser_vpn;
  priv_override.scope = "space:" + priv;
  priv_override.endpoint = "socks5://127.0.0.1:10809";
  assert(state.SetTunnelPolicy(priv_override).ok);

  // Drop browser tunnel -> strict_tunnel + fail_closed MUST block traffic & compute blackhole rule.
  assert(state.SetTunnelHealth("browser", false).ok);
  auto blocked_shared = state.CheckNetworkAllowedForSpace(shared);
  assert(!blocked_shared.ok &&
         blocked_shared.error_code == "ERR_TUNNEL_DISCONNECTED_FAIL_CLOSED");

  auto statuses = state.GetTunnelStatuses("browser");
  assert(statuses.size() == 1);
  assert(KernelState::ComputeEffectiveProxyRule(statuses[0]) == "PROXY 0.0.0.0:0");

  // Private space with its own healthy tunnel stays operational.
  assert(state.CheckNetworkAllowedForSpace(priv).ok);

  assert(state.SetTunnelHealth("browser", true).ok);
  assert(state.CheckNetworkAllowedForSpace(shared).ok);
  std::cout << "[PASS] C++20 P1 independent VPN + Fail-Closed Kill-Switch invariants\n";
}

void TestPosixUds0600AndPeerCred() {
  std::string sock_dir = "/tmp/gador-cpp-test-" + std::to_string(::getpid());
  std::string sock_path = sock_dir + "/ctl.sock";

  UdsPosixServer server(
      sock_path,
      [](const std::string& req) -> std::string {
        return std::string(R"({"ok":true,"echo":)") + req + "}";
      },
      []() -> std::vector<std::string> {
        return {R"({"event":"dialog.opened","params":{"replayed":true}})"};
      });

  std::string err;
  assert(server.Start(&err));

  // Verify strict 0600 socket permissions on disk.
  struct stat st {};
  assert(::stat(sock_path.c_str(), &st) == 0);
  assert((st.st_mode & 0777) == 0600);

  // Connect via POSIX AF_UNIX client (same UID passes SO_PEERCRED).
  int fd = ::socket(AF_UNIX, SOCK_STREAM, 0);
  assert(fd >= 0);
  sockaddr_un addr{};
  addr.sun_family = AF_UNIX;
  std::strncpy(addr.sun_path, sock_path.c_str(), sizeof(addr.sun_path) - 1);
  assert(::connect(fd, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) == 0);

  // Send a fragmented frame (2 bytes at a time) and verify replay event + RPC reply.
  auto req_frame = EncodeFrame(R"({"id":7,"method":"agent.capabilities"})");
  for (size_t i = 0; i < req_frame.size(); i += 2) {
    size_t chunk = std::min<size_t>(2, req_frame.size() - i);
    ssize_t w = ::write(fd, req_frame.data() + i, chunk);
    assert(w == static_cast<ssize_t>(chunk));
  }

  FrameDecoder decoder;
  std::vector<std::string> received;
  uint8_t buf[1024];
  while (received.size() < 2) {
    ssize_t n = ::read(fd, buf, sizeof(buf));
    assert(n > 0);
    auto res = decoder.Push(buf, static_cast<size_t>(n));
    assert(res.ok);
    for (auto& s : res.frames) {
      received.push_back(std::move(s));
    }
  }
  assert(received[0].find("replayed") != std::string::npos);
  assert(received[1].find("agent.capabilities") != std::string::npos);

  ::close(fd);
  server.Stop();
  std::filesystem::remove_all(sock_dir);
  std::cout << "[PASS] C++20 POSIX UDS 0600 + SO_PEERCRED + replay + fragmented RPC\n";
}

void TestCredentialAndPaymentSecurityGuard() {
  // 1. Internal password manager, payment settings, and local files are hard-blocked.
  assert(CheckAgentUrlPolicy("chrome://password-manager/passwords").verdict ==
         SecurityVerdict::kDenyDomain);
  assert(CheckAgentUrlPolicy("chrome://settings/payments").verdict ==
         SecurityVerdict::kDenyDomain);
  assert(CheckAgentUrlPolicy("file:///home/user/.config/gador/Default/Login Data").verdict ==
         SecurityVerdict::kDenyDomain);
  assert(CheckAgentUrlPolicy("view-source:chrome://settings/passwords").verdict ==
         SecurityVerdict::kDenyDomain);
  assert(CheckAgentUrlPolicy("https://example.com/docs").Allowed());

  // 2. Sensitive CDP domains/methods (Autofill/WebAuthn/FedCm/setFileInputFiles) blocked.
  assert(CheckCdpPolicy("Autofill.trigger", "{}", "https://example.com", false).verdict ==
         SecurityVerdict::kDenyDomain);
  assert(CheckCdpPolicy("WebAuthn.enable", "{}", "https://example.com", false).verdict ==
         SecurityVerdict::kDenyDomain);
  assert(CheckCdpPolicy("DOM.setFileInputFiles", "{}", "https://example.com", false).verdict ==
         SecurityVerdict::kDenyDomain);
  assert(CheckCdpPolicy("Page.navigate", R"({"url":"chrome://settings/payments"})",
                        "https://example.com", false).verdict ==
         SecurityVerdict::kDenyDomain);

  // 3. Password focus, payment checkout URL, or password/card JS forces USER_ACTIVE takeover.
  assert(CheckCdpPolicy("Input.insertText", R"({"text":"secret"})",
                        "https://example.com/login", true).verdict ==
         SecurityVerdict::kRequireHumanTakeover);
  assert(CheckCdpPolicy("Page.captureScreenshot", "{}",
                        "https://example.com/login", true).verdict ==
         SecurityVerdict::kRequireHumanTakeover);
  assert(CheckCdpPolicy("Input.insertText", R"({"text":"4111"})",
                        "https://checkout.stripe.com/c/pay/cs_test", false).verdict ==
         SecurityVerdict::kRequireHumanTakeover);
  assert(CheckCdpPolicy("Runtime.evaluate",
                        R"({"expression":"document.querySelector('input[type=\"password\"]').value"})",
                        "https://example.com", false).verdict ==
         SecurityVerdict::kRequireHumanTakeover);

  // 4. End-to-end via RpcRouter: forced takeover freezes the space into USER_ACTIVE.
  RpcRouter router;
  auto sp_reply = router.HandleRequestJson(
      R"({"id":1,"method":"space.create","params":{"name":"sec","authMode":"shared"}})");
  assert(sp_reply.find("sp_1") != std::string::npos);

  auto bad_open = router.HandleRequestJson(
      R"({"id":2,"method":"page.open","params":{"spaceId":"sp_1","url":"chrome://settings/payments"}})");
  assert(bad_open.find("ERR_DOMAIN_DENIED") != std::string::npos);

  auto pay_open = router.HandleRequestJson(
      R"({"id":3,"method":"page.open","params":{"spaceId":"sp_1","url":"https://shop.example/checkout"}})");
  assert(pay_open.find("pg_1") != std::string::npos);

  auto blocked_pay = router.HandleRequestJson(
      R"({"id":4,"method":"cdp.send","params":{"pageId":"pg_1","cdpMethod":"Input.insertText","cdpParams":{"text":"4242"}}})");
  assert(blocked_pay.find("ERR_SENSITIVE_ACTION_REQUIRES_HUMAN") != std::string::npos);

  // Space is now frozen in USER_ACTIVE until human explicitly releases it.
  auto follow_up = router.HandleRequestJson(
      R"({"id":5,"method":"cdp.send","params":{"pageId":"pg_1","cdpMethod":"Page.captureScreenshot"}})");
  assert(follow_up.find("ERR_HUMAN_IN_CONTROL") != std::string::npos);

  std::cout << "[PASS] C++20 Credential & Payment Security Guard (storage blocked + forced USER_ACTIVE)\n";
}

}  // namespace

int main() {
  TestFramingFragmentedAndCoalesced();
  TestP0SpaceLifecycleHotMountTakeoverDialogs();
  TestP1IndependentVpnAndFailClosed();
  TestPosixUds0600AndPeerCred();
  TestCredentialAndPaymentSecurityGuard();
  std::cout << "ALL C++20 KERNEL CORE TESTS PASSED.\n";
  return 0;
}
