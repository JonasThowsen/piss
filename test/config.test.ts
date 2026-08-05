import assert from "node:assert/strict";
import test from "node:test";
import { resolveSshAuthSock } from "../server/config.ts";

test("SSH agent resolution shares one stable socket with every runtime", () => {
  assert.equal(resolveSshAuthSock({ PISS_SSH_AUTH_SOCK: "/custom/agent.sock", SSH_AUTH_SOCK: "/inherited/agent.sock", XDG_RUNTIME_DIR: "/run/user/1000" }), "/custom/agent.sock");
  assert.equal(resolveSshAuthSock({ SSH_AUTH_SOCK: "/inherited/agent.sock", XDG_RUNTIME_DIR: "/run/user/1000" }), "/inherited/agent.sock");
  assert.equal(resolveSshAuthSock({ XDG_RUNTIME_DIR: "/run/user/1000" }), "/run/user/1000/ssh-agent");
  assert.equal(resolveSshAuthSock({}), undefined);
});
