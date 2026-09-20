# tests/test_bridge_catalog.py - every registry tool must resolve to a real path.
#   python3 tests/test_bridge_catalog.py
# With no Studio running and no MCP server started, each of the 113 tools must
# return either ok (local handlers) or a precise offline kind (mcp_offline /
# studio_offline / validation_error) - never "unknown tool". That proves the
# full catalog is wired end to end (bridge routing), not just listed.
import sys, os, json, types, unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

# Stub `websockets` so bridge.py can be imported without the dependency.
sys.modules.setdefault("websockets", types.ModuleType("websockets"))
sys.path.insert(0, ROOT)  # repo root
import bridge


class CatalogTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with open(os.path.join(ROOT, "tests", "__registry__.json"), encoding="utf-8") as f:
            cls.registry = json.load(f)
        try:
            with open(os.path.join(ROOT, "tests", "tool-samples.json"), encoding="utf-8") as f:
                cls.samples = json.load(f)
        except Exception:
            cls.samples = {}
        # Fresh manager, servers configured but never started: Studio-routed
        # tools must report mcp_offline without hanging or crashing.
        cls.mgr = bridge.MCPManager()
        cls.mgr.load_config()
        bridge.mgr = cls.mgr

    def test_registry_has_113(self):
        self.assertEqual(len(self.registry), 113, f"registry has {len(self.registry)} tools")
        self.assertEqual(len(set(self.registry)), 113, "registry has duplicates")

    def test_unknown_names_fail_fast_with_suggestions(self):
        import time
        for bad, want_hint in (("create_animation", "create_animation_track"),
                               ("execut_luau", "execute_luau"),
                               ("set_proprety", "set_properties")):
            t0 = time.monotonic()
            res = bridge.safe_call(bad, {}, 5)
            dt = time.monotonic() - t0
            self.assertFalse(res["ok"], bad)
            self.assertEqual(res["kind"], "validation_error", (bad, res))
            self.assertIn(want_hint, res["error"], (bad, res["error"]))
            self.assertLess(dt, 2.0, f"{bad} took {dt:.1f}s, must fail fast")

    def test_list_tools_covers_registry(self):
        advertised = {t.get("name") for t in self.mgr.list_tools()}
        missing = sorted(set(self.registry) - advertised)
        self.assertEqual(missing, [], f"not advertised: {missing}")

    def test_every_tool_routes(self):
        bad = []
        for name in self.registry:
            args = self.samples.get(name, {})
            if not isinstance(args, dict):
                args = {}
            try:
                res = bridge.safe_call(name, args, 5)
            except Exception as e:  # safe_call must never raise
                bad.append((name, f"raised {e!r}"))
                continue
            if not isinstance(res, dict) or "ok" not in res:
                bad.append((name, f"bad shape {res!r}"[:120]))
                continue
            if res.get("ok"):
                continue
            kind = res.get("kind", "")
            err = str(res.get("error", ""))
            if kind == "RuntimeError" or "unknown tool" in err.lower():
                bad.append((name, f"{kind}: {err}"[:160]))
            elif kind not in ("validation_error", "mcp_offline", "studio_offline",
                              "timeout", "execution_error", "cancelled"):
                bad.append((name, f"unexpected kind {kind}: {err}"[:160]))
        self.assertEqual(bad, [], f"{len(bad)} tools do not route:\n" + "\n".join(f"{n}: {e}" for n, e in bad[:15]))


if __name__ == "__main__":
    unittest.main(verbosity=1)
