#include <atomic>
#include <chrono>
#include <csignal>
#include <cstdlib>
#include <iostream>
#include <string>
#include <thread>

#include "kernel/core/rpc_router.h"
#include "kernel/core/uds_posix_server.h"

namespace {

std::atomic<bool> g_stop{false};

void HandleSignal(int) {
  g_stop.store(true);
}

}  // namespace

// Standalone native C++20 UDS Kernel Daemon using the exact same
// UdsPosixServer + RpcRouter + KernelState that runs inside Chromium 158.
// Used for cross-language C++ <-> Node P0/P1 regression gate verification.
int main(int argc, char** argv) {
  std::string socket_path = "/tmp/gador-daemon.sock";
  if (argc >= 2) {
    socket_path = argv[1];
  } else if (const char* env_sock = std::getenv("AGENT_KERNEL_SOCKET");
             env_sock && env_sock[0] != '\0') {
    socket_path = env_sock;
  }

  std::signal(SIGINT, HandleSignal);
  std::signal(SIGTERM, HandleSignal);

  agent_kernel::core::UdsPosixServer* server_ptr = nullptr;
  agent_kernel::core::RpcRouter router(
      [&server_ptr](const std::string& event_json) {
        if (server_ptr) {
          server_ptr->Broadcast(event_json);
        }
      },
      agent_kernel::core::RuntimeMode::kDaemon);

  // Seed one simulated personal session cookie for dual-auth E2E verification.
  router.SeedPersonalCookie("ba_session", "personal_logged_in_token");

  agent_kernel::core::UdsPosixServer server(
      socket_path,
      [&router](const std::string& req) {
        return router.HandleRequestJson(req);
      },
      [&router]() { return router.BuildReconnectReplayEvents(); });
  server_ptr = &server;

  std::string err;
  if (!server.Start(&err)) {
    std::cerr << "Failed to start C++ UDS kernel daemon: " << err << "\n";
    return 1;
  }

  std::cout << "READY " << socket_path << std::endl;
  while (!g_stop.load()) {
    std::this_thread::sleep_for(std::chrono::milliseconds(50));
  }
  server.Stop();
  return 0;
}
