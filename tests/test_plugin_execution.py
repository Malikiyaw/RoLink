# tests/test_plugin_execution.py - 2.2.0 execution hardening.
#   python3 tests/test_plugin_execution.py
# Covers: bridge Luau preflight rejects yield-less infinite loops, plugin
# no longer calls debug.sethook unconditionally (HAS_SETHOOK guard), and
# get_animation_info supports path-based reads for in-place sequences.
import sys, os, json, unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)
import bridge


class PluginExecutionTest(unittest.TestCase):
    def test_infinite_loop_preflight(self):
        res = bridge.safe_call("execute_luau", {"code": "while true do print(1) end"}, 5)
        self.assertFalse(res["ok"])
        self.assertEqual(res["kind"], "validation_error")
        self.assertIn("infinite loop", res["error"].lower())

    def test_loop_with_yield_passes_preflight(self):
        err = bridge._luau_preflight("while true do task.wait(0.1) print(1) end")
        self.assertIsNone(err)

    def test_normal_code_passes_preflight(self):
        err = bridge._luau_preflight("return 1+1")
        self.assertIsNone(err)

    def test_plugin_guards_sethook(self):
        with open(os.path.join(ROOT, "studio-plugin", "RoLink.lua"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("HAS_SETHOOK", src)
        self.assertIn("riskyLoop", src)
        self.assertIn("applyEnv", src)
        # No busy-resume loop: yields must propagate via direct pcall.
        self.assertNotIn("coroutine.resume(tracked", src)
        self.assertIn("table.pack(pcall(fn", src)

    def test_yield_and_play_honesty(self):
        with open(os.path.join(ROOT, "studio-plugin", "RoLink.lua"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("task.spawn", src)  # poll runs yield-safe
        self.assertIn("IN_PLAY_MODE", src)
        self.assertIn("playable", src)
        self.assertIn("Edit DataModel", src)
        self.assertIn("require_failed", src)
        self.assertIn("compiler_error", src)
        self.assertIn('mod.Parent = game:GetService("ServerStorage")', src)
        self.assertIn("__RL_BUSY", src)
        self.assertIn("resolveAnimationId", src)
        self.assertIn("runtimeSnippet", src)
        # Generic Script:line unwrap must be gone (it relabeled every error).
        self.assertNotIn('[Ss]cript:%d+', src)

    def test_marker_leak_stripped(self):
        res = bridge.safe_call("set_script_content", {"path": "Workspace/X", "content": "###LUA###\nreturn 1\n###END_LUA###"}, 5)
        # Marker content is stripped at safe_call before queue/MCP, so large-set would be reached but
        # here it must not mislabel as compiler_error and must not allocate a command
        self.assertIn(res["kind"], ("mcp_offline", "plugin_offline", "validation_error"))
        self.assertNotIn("###LUA", str(res.get("error", "")) + str(res.get("text", "")))
        err = bridge._luau_preflight("###LUA###\nreturn {a=1}\n###END_LUA###")
        self.assertIn("###LUA", err)
        with open(os.path.join(ROOT, "studio-plugin", "RoLink.lua"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("stripMarkers", src)
        self.assertIn("compiler_error", src)

    def test_large_script_content_fails_fast(self):
        res = bridge.safe_call("set_script_content", {"path": "Workspace/X", "content": "x" * 100001}, 5)
        self.assertFalse(res["ok"])
        self.assertEqual(res["kind"], "validation_error")
        self.assertIn("100000", res["error"])

    def test_queue_single_flight(self):
        c1 = bridge.queue_enqueue("get_instances", "get_instances", {})
        taken = bridge.queue_take()
        self.assertIsNotNone(taken)
        self.assertEqual(taken["id"], c1)
        c2 = bridge.queue_enqueue("get_instances", "get_instances", {})
        self.assertIsNone(bridge.queue_take(), "second claim must wait for expiry")
        bridge.queue_cancel(taken["id"])
        bridge.queue_cancel(c2)

    def test_animation_info_path_support(self):
        with open(os.path.join(ROOT, "studio-plugin", "RoLink.lua"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("summarizeSequence", src)
        self.assertIn("pathArg", src)
        with open(os.path.join(ROOT, "mcp-server", "src", "tools", "registry.ts"), encoding="utf-8") as f:
            reg = f.read()
        idx = reg.find("get_animation_info")
        self.assertGreater(idx, 0)
        window = reg[idx:idx + 800]
        self.assertIn("path", window)

    def test_extension_prompt_escapes(self):
        import re
        with open(os.path.join(ROOT, "rolink-extension", "core", "config.js"), encoding="utf-8") as f:
            src = f.read()
        # Every literal `require()` mention in prompt text must be escaped;
        # a bare backtick inside the template literal breaks parsing so RL
        # never defines and Start fails with "RL is not defined".
        self.assertNotRegex(src, r"(?<!\\)`require\(\)")
        self.assertIn("\\`require()\\`", src)

    def test_stuck_execution_guidance(self):
        err = bridge._ai_readable_error("stuck-execution", "no plugin answer in 20s (queue: 0 pending)", "execute_luau")
        self.assertIn("plugin_status", err)
        self.assertIn("Do NOT resend", err)
        self.assertNotIn("install-plugin.bat", err)

    def test_plugin_offline_still_has_install_steps(self):
        err = bridge._ai_readable_error("plugin_offline", "never seen", "execute_luau")
        self.assertIn("install-plugin.bat", err)

    def test_get_all_properties_no_pairs_on_instance(self):
        with open(os.path.join(ROOT, "studio-plugin", "RoLink.lua"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("safeProps", src)
        self.assertIn("COMMON_PROPS", src)
        self.assertNotIn("pairs(inst::any)", src)
        self.assertNotIn("in pairs(inst)", src)

    def test_animation_easing_bake(self):
        with open(os.path.join(ROOT, "studio-plugin", "RoLink.lua"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("bakeEased", src)
        self.assertIn("EASE_FNS", src)
        self.assertIn("non-decreasing", src)
        with open(os.path.join(ROOT, "mcp-server", "src", "tools", "registry.ts"), encoding="utf-8") as f:
            reg = f.read()
        self.assertIn("quadInOut", reg)

    def test_cinematic_tools_wired(self):
        for name in ("create_cutscene", "create_dialogue", "create_motion_effect", "create_vfx"):
            with open(os.path.join(ROOT, "tests", "__registry__.json"), encoding="utf-8") as f:
                self.assertIn(name, json.load(f))
        with open(os.path.join(ROOT, "studio-plugin", "RoLink.lua"), encoding="utf-8") as f:
            src = f.read()
        for branch in ('tool=="create_cutscene"', 'tool=="create_dialogue"',
                       'tool=="create_motion_effect"', 'tool=="create_vfx"'):
            self.assertIn(branch, src)
        with open(os.path.join(ROOT, "mcp-server", "src", "tools", "registry.ts"), encoding="utf-8") as f:
            reg = f.read()
        for name in ("create_cutscene", "create_dialogue", "create_motion_effect", "create_vfx"):
            self.assertIn('name: "%s"' % name, reg)

    def test_batch_cap_is_ten(self):
        res = bridge.safe_call("batch_queue", {"commands": [{"tool": "get_time", "args": {}}] * 11}, 5)
        self.assertFalse(res["ok"])
        self.assertEqual(res["kind"], "validation_error")
        self.assertIn("10", res["error"])

    def test_clip_and_publish_wired(self):
        for name in ("export_animation_clip", "publish_animation"):
            with open(os.path.join(ROOT, "tests", "__registry__.json"), encoding="utf-8") as f:
                self.assertIn(name, json.load(f))
        with open(os.path.join(ROOT, "studio-plugin", "RoLink.lua"), encoding="utf-8") as f:
            src = f.read()
        for branch in ('tool=="export_animation_clip"', 'tool=="publish_animation"',
                       "exportAnimationClip", "prepareAnimation", "registerAnimation",
                       "clipCurves", "findClipTwin"):
            self.assertIn(branch, src)
        with open(os.path.join(ROOT, "mcp-server", "src", "tools", "registry.ts"), encoding="utf-8") as f:
            reg = f.read()
        for name in ("export_animation_clip", "publish_animation"):
            self.assertIn('name: "%s"' % name, reg)

    def test_publish_register_validates_asset_id(self):
        res = bridge.safe_call("publish_animation", {"action": "register", "assetId": "not-an-id"}, 5)
        # Offline Studio cannot verify, but routing must resolve (mcp_offline),
        # never "unknown tool".
        self.assertIn(res["kind"], ("mcp_offline", "plugin_offline", "stuck-execution", "validation_error", "execution_error"))
        self.assertNotIn("unknown tool", str(res.get("error", "")).lower())

    def test_deepseek_reskin_fallbacks(self):
        with open(os.path.join(ROOT, "rolink-extension", "providers", "deepseek.js"), encoding="utf-8") as f:
            src = f.read()
        # v4.1 composer: send lookup survives a missing .ds-button--primary,
        # unknown pickers are never clicked, search blocks explain themselves.
        self.assertIn("function findSendBtn", src)
        self.assertIn("needSearchOff", src)
        self.assertNotIn("composerFrame() || document", src)  # no recurse: frame scoping stays direct
        # findSendBtn must query the DOM, never itself (self-recursion kills
        # the content script: no bar, Errors button on the extension card).
        body = src.split("function findSendBtn", 1)[1].split("\n  }\n", 1)[0]
        self.assertNotIn("findSendBtn()", body)
        self.assertIn("document.querySelector(S.sendBtn)", body)
        with open(os.path.join(ROOT, "rolink-extension", "core", "main.js"), encoding="utf-8") as f:
            main = f.read()
        self.assertIn("needSearchOff", main)
        self.assertIn("Smart Search", main)


if __name__ == "__main__":
    unittest.main(verbosity=1)
