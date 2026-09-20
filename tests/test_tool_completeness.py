# tests/test_tool_completeness.py - all 113 tools exist in every layer.
#   python3 tests/test_tool_completeness.py
# For each registry name: (a) zod schema in mcp-server registry.ts,
# (b) dispatcher branch in studio-plugin/RoLink.lua, (c) prompt entry in
# generated/tool-prompts.json, (d) sample args (tool-samples.json) or an
# extension fixture. Fails naming the tool and the missing piece.
import io, os, json, unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)


def read(*parts):
    with io.open(os.path.join(ROOT, *parts), encoding="utf-8", errors="replace") as f:
        return f.read()


class CompletenessTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with io.open(os.path.join(ROOT, "tests", "__registry__.json"), encoding="utf-8") as f:
            cls.registry = json.load(f)
        with io.open(os.path.join(ROOT, "generated", "tool-prompts.json"), encoding="utf-8") as f:
            cls.prompts = json.load(f).get("prompts", {})
        try:
            with io.open(os.path.join(ROOT, "tests", "tool-samples.json"), encoding="utf-8") as f:
                cls.samples = json.load(f)
        except Exception:
            cls.samples = {}
        cls.registry_ts = read("mcp-server", "src", "tools", "registry.ts")
        cls.plugin = read("studio-plugin", "RoLink.lua")
        import glob
        cls.fixtures = {os.path.splitext(os.path.basename(p))[0]
                        for p in glob.glob(os.path.join(
                            ROOT, "rolink-extension", "core", "__fixtures__",
                            "tool-calls", "*.txt"))}

    def test_registry_is_113_unique(self):
        self.assertEqual(len(self.registry), 113)
        self.assertEqual(len(set(self.registry)), 113)

    def test_every_tool_in_registry_ts(self):
        missing = [n for n in self.registry if f'name: "{n}"' not in self.registry_ts]
        self.assertEqual(missing, [], f"no zod schema: {missing}")

    def test_every_tool_in_studio_plugin(self):
        # Dispatcher uses tool=="<name>" branches (aliases included, e.g.
        # tool=="run_code" shares the execute_luau branch).
        missing = [n for n in self.registry if f'"{n}"' not in self.plugin]
        self.assertEqual(missing, [], f"no plugin branch: {missing}")

    def test_every_tool_has_prompt(self):
        missing = [n for n in self.registry if n not in self.prompts]
        self.assertEqual(missing, [], f"no prompt: {missing}")
        for n in self.registry:
            for field in ("when_to_use", "args_guide", "example_call", "pitfalls"):
                self.assertTrue((self.prompts[n].get(field) or "").strip(),
                                f"{n}: prompt field {field} empty")

    def test_every_tool_has_sample_or_fixture(self):
        missing = [n for n in self.registry
                   if n not in self.samples and n not in self.fixtures]
        self.assertEqual(missing, [], f"no sample/fixture: {missing}")

    def test_plugin_has_no_hud(self):
        # The in-Studio hologram HUD is removed: a Visualizer throw inside
        # poll() used to abort the whole poll, so claimed commands were never
        # reported and the bridge timed out. The bridge terminal is the display.
        for marker in ("Visualizer", "VHud", "VLog", "VStats", "hudBtn",
                       "hologram", "RoLinkHUD"):
            self.assertNotIn(marker, self.plugin, f"HUD remnant: {marker}")
        # ...but the execution + reporting path must survive the removal.
        for snippet in ("local function poll()", "executeCommand(cmd)",
                        "reportResult(cmd.id, result, err, elapsed)",
                        "local function executeCommand",
                        "/queue/next", "/queue/result"):
            self.assertIn(snippet, self.plugin, f"poll path broken, missing: {snippet}")

    def test_plugin_character_help(self):
        # CHARACTER errors must name real rigs; render honesty needs IsRunning.
        for snippet in ("local function rigCandidates", "FindFirstChildOfClass(\"Humanoid\")",
                        "Rigs with a Humanoid here", "IsRunning()",
                        "Edit mode never renders animation playback"):
            self.assertIn(snippet, self.plugin, f"missing: {snippet}")

    def test_plugin_version_handshake(self):
        # Poll carries ?pv=PLUGIN_VERSION; bridge tracks + warns on mismatch.
        # PLUGIN_VERSION must equal the repo VERSION (kept in sync by hand).
        import re
        m = re.search(r'local PLUGIN_VERSION = "([^"]+)"', self.plugin)
        self.assertIsNotNone(m, "PLUGIN_VERSION missing in plugin")
        repo_version = open(os.path.join(ROOT, "VERSION"), encoding="utf-8").read().strip()
        self.assertEqual(m.group(1), repo_version,
                         f"plugin {m.group(1)} != repo {repo_version}")
        self.assertIn("pv=", self.plugin)
        bridge_src = open(os.path.join(ROOT, "bridge.py"), encoding="utf-8").read()
        self.assertIn("VERSION MISMATCH", bridge_src)

    def test_plugin_sandbox_parity(self):
        # The index-nil class dies here: datatype globals the model uses.
        for g in ("Vector3=", "Vector2=", "CFrame=", "Color3=", "UDim2=",
                  "BrickColor=", "TweenInfo=", "utf8=", "bit32=", "coroutine="):
            self.assertIn(g, self.plugin, f"sandbox missing: {g}")

    def test_plugin_stuck_watchdog(self):
        # Hung executions must announce themselves in Studio Output.
        for snippet in ("STILL RUNNING", "probable infinite loop",
                        "do not resend the same code"):
            self.assertIn(snippet, self.plugin, f"missing: {snippet}")


if __name__ == "__main__":
    unittest.main(verbosity=1)
