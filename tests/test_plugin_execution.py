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

    def test_deepseek_injects_on_bare_domain(self):
        import json as _json
        with open(os.path.join(ROOT, "rolink-extension", "manifest.json"), encoding="utf-8") as f:
            manifest = _json.load(f)
        with open(os.path.join(ROOT, "rolink-extension", "background.js"), encoding="utf-8") as f:
            bg = f.read()
        deepseek_scripts = [c for c in manifest["content_scripts"]
                            if "providers/deepseek.js" in c.get("js", [])]
        self.assertTrue(deepseek_scripts, "no deepseek content script entry")
        matches = deepseek_scripts[0]["matches"]
        # Bare deepseek.com must inject (v4.1 serves pages there); host
        # permissions already allowed it, but content_scripts did not.
        self.assertIn("https://deepseek.com/*", matches)
        self.assertIn("https://chat.deepseek.com/*", matches)
        self.assertIn("https://deepseek.com/*", bg)


    def test_no_legacy_branding(self):
        # No ZeroScript remnants anywhere: no product name (any case), no
        # legacy code/storage identifiers, no old invite or tip links, no stale
        # repo URL. Migration fallbacks are the one exception: lines marked
        # legacy (or the line above them) may name the old storage keys.
        import re
        banned = [
            r"zeroscript",  # case-insensitive below
            r"ZSParse", r"ZSProvider", r"__zs", r"#zs-", r"data-zs",
            r"zs-diag", r"ZS_BRIDGE_PORT", r"ZS_STUDIO_MCP_PATH",
            r"zStopped", r"zloop", r"zResume", r"zResumeLen", r"zphase",
            r"zsToolT0", r"zsGenT0", r"zsCode", r"zsPlaceholder",
            r"zsGptVer", r"zsDsVer", r"zsSys", r"zsCustomPrompt",
            r"zsCustomMcpServers", r"zsImageTools", r"zsStartedSessions",
            r"zsSetupSeen", r"zsQwenModelVision2", r"domHasZsSignal",
            r"D5G2HAzX8z", r"KOFI_URL", r"sebattfg/RoLink-Free",
        ]
        text_exts = (".js", ".ts", ".html", ".css", ".json", ".md", ".py",
                     ".lua", ".txt", ".bat", ".sh", ".command")
        hits = []
        for dirpath, dirnames, filenames in os.walk(ROOT):
            dirnames[:] = [d for d in dirnames if d != ".git"]
            for fn in filenames:
                if not fn.endswith(text_exts):
                    continue
                p = os.path.join(dirpath, fn)
                if os.path.abspath(p) == os.path.abspath(__file__):
                    continue
                try:
                    with open(p, encoding="utf-8") as f:
                        lines = f.read().splitlines()
                except (OSError, UnicodeDecodeError):
                    continue
                for i, line in enumerate(lines):
                    window = [lines[j] for j in range(max(0, i - 3), i + 1)]
                    if any(re.search(r"legacy", w, re.IGNORECASE) for w in window):
                        continue
                    for pat in banned:
                        flags = re.IGNORECASE if pat == "zeroscript" else 0
                        if re.search(pat, line, flags):
                            hits.append("%s:%d: %s" % (
                                os.path.relpath(p, ROOT), i + 1, pat))
                            break
        self.assertEqual(hits, [], "legacy remnants:\n" + "\n".join(hits[:20]))

    def test_sandbox_exposes_standard_builtins(self):
        # pcall(require, ...) failed with "attempt to call a nil value" because
        # safeEnv lacked the builtins themselves. All three env definitions
        # must provide them.
        for rel in ("studio-plugin/RoLink.lua",
                    "studio-plugin/src/plugin/init.plugin.luau",
                    "studio-plugin/src/sandbox.luau"):
            with open(os.path.join(ROOT, rel), encoding="utf-8") as f:
                src = f.read()
            for name in ("pcall=pcall", "require=require", "assert=assert",
                         "select=select", "unpack=unpack"):
                self.assertIn(name, src, "%s missing %s" % (rel, name))

    def test_hanging_snippet_times_out_without_wedging(self):
        for rel in ("studio-plugin/RoLink.lua",
                    "studio-plugin/src/plugin/init.plugin.luau"):
            with open(os.path.join(ROOT, rel), encoding="utf-8") as f:
                src = f.read()
            # Wall-clock deadline on its own coroutine: a hung require/wait
            # reports a timeout instead of wedging the single-flight queue.
            self.assertIn("runWithDeadline", src)
            self.assertIn("EXEC_BUDGET_S", src)
            self.assertIn("coroutine.create", src)
            self.assertIn("still running after", src)

    def test_execute_luau_warns_against_bulk_require(self):
        with open(os.path.join(ROOT, "mcp-server", "src", "tools", "toolPrompts.ts"),
                  encoding="utf-8") as f:
            src = f.read()
        self.assertIn("never bulk-require", src)
        with open(os.path.join(ROOT, "generated", "tool-prompts.json"), encoding="utf-8") as f:
            import json as _json
            gen = _json.load(f)["prompts"]["execute_luau"]["pitfalls"]
        self.assertIn("never bulk-require", gen)

    def test_runtime_error_names_offending_line(self):
        with open(os.path.join(ROOT, "studio-plugin", "RoLink.lua"), encoding="utf-8") as f:
            src = f.read()
        # Runtime errors must carry the failing source line, not just a
        # 120-char head: '[string "RoLink"]:460' is useless on long scripts.
        self.assertIn("errLineCtx", src)
        self.assertIn('>> line "', src)
        self.assertIn("attempt to call a nil value", src)
        # Both runtime-failure returns in sandboxRun attach the context.
        self.assertEqual(src.count("errLineCtx(code,"), 2)
        with open(os.path.join(ROOT, "studio-plugin", "src", "plugin", "init.plugin.luau"),
                  encoding="utf-8") as f:
            mirror = f.read()
        self.assertIn("errLineCtx", mirror)
        self.assertIn("errLineCtx(code, errMsg)", mirror)

    def test_easing_aliases_and_tool_deadline(self):
        with open(os.path.join(ROOT, "studio-plugin", "RoLink.lua"), encoding="utf-8") as f:
            src = f.read()
        # Bare family names normalize instead of erroring (the 'quad' report).
        self.assertIn('quad = "quadInOut"', src)
        self.assertIn('cubic = "cubicInOut"', src)
        self.assertIn('sine = "sineInOut"', src)
        self.assertIn("function resolveEasing", src)
        # Unknown names still error, with the same prefix plus a hint.
        self.assertIn("unknown easing '", src)
        self.assertIn("did you mean", src)
        self.assertIn("EASE_LIST", src)
        # Instance budget fails fast instead of wedging the queue.
        self.assertIn("totalPoses", src)
        self.assertIn("max 1024", src)
        self.assertIn("made % 128", src)
        # Every tool (not just Luau snippets) runs under a wall-clock
        # deadline; the poll loop routes through it instead of bare pcall.
        self.assertIn("TOOL_BUDGET_S", src)
        self.assertIn("function runToolDeadline", src)
        self.assertIn("runToolDeadline(cmd)", src)
        self.assertIn("still running after", src)
        # Exactly one bare dispatch left, inside the deadline runner itself.
        self.assertEqual(src.count("pcall(executeCommand, cmd)"), 1)
        # Prompt surfaces document the enum and the budget.
        with open(os.path.join(ROOT, "mcp-server", "src", "tools", "registry.ts"),
                  encoding="utf-8") as f:
            reg = f.read()
        self.assertIn("quadIn/Out/InOut", reg)
        self.assertIn("1024", reg)
        with open(os.path.join(ROOT, "mcp-server", "src", "tools", "toolPrompts.ts"),
                  encoding="utf-8") as f:
            prompts = f.read()
        self.assertIn("bare quad", prompts)
        with open(os.path.join(ROOT, "generated", "tool-prompts.json"), encoding="utf-8") as f:
            import json as _json2
            gen = _json2.load(f)["prompts"]["create_animation_track"]["pitfalls"]
        self.assertIn("bare quad", gen)


if __name__ == "__main__":
    unittest.main(verbosity=1)
