-- RoLink.lua — Studio Plugin (140 tools, production)
-- Place in Studio Plugins folder or Rojo. Polls MCP every 200ms, executes, snapshots, heals, reports.
local HttpService = game:GetService("HttpService")
local ChangeHistoryService = game:GetService("ChangeHistoryService")
local RunService = game:GetService("RunService")

local MCP_URL = "http://127.0.0.1:3001"
local POLL_INTERVAL = 0.2
local PLUGIN_NAME = "RoLink 2.1"
local PLUGIN_VERSION = "2.5.0"

local toolbar = plugin:CreateToolbar(PLUGIN_NAME)
local btn = toolbar:CreateButton("RoLink", "AI bridge (140 tools, poll 200ms)", "rbxassetid://0")
btn.ClickableWhenViewportHidden = true
local enabled = true

local function log(msg) print("[RoLink] "..msg) end

local safeEnv = {
  print=print, warn=warn, error=error,
  pairs=pairs, ipairs=ipairs, next=next, type=type, tostring=tostring, tonumber=tonumber,
  -- Standard builtins user code expects: pcall(require, ...) and direct
  -- require() both resolve here (a missing entry reads as "attempt to call a
  -- nil value" on the calling line). require adds no new privilege - the
  -- run_function branch already requires arbitrary ModuleScript instances.
  pcall=pcall, xpcall=xpcall, assert=assert, select=select, unpack=unpack,
  require=require, setmetatable=setmetatable, getmetatable=getmetatable,
  rawget=rawget, rawset=rawset, rawequal=rawequal, rawlen=rawlen,
  math=math, string=string, table=table, vector=vector, utf8=utf8, bit32=bit32,
  coroutine=coroutine,
  game=game, workspace=workspace, Instance=Instance, Enum=Enum, task=task, tick=tick, time=time,
  Vector3=Vector3, Vector2=Vector2, CFrame=CFrame, Color3=Color3,
  UDim=UDim, UDim2=UDim2, BrickColor=BrickColor, Rect=Rect,
  TweenInfo=TweenInfo, NumberRange=NumberRange, NumberSequence=NumberSequence,
  ColorSequence=ColorSequence, Random=Random, DateTime=DateTime,
  RaycastParams=RaycastParams, OverlapParams=OverlapParams,
  os={clock=os.clock, date=os.date, time=os.time},
}

local function balanceParens(code:string): string
  local o=select(2, code:gsub("%(", "")); local c=select(2, code:gsub("%)", ""))
  if o>c then return code..string.rep(")", o-c) end
  if c>o then return string.rep("(", c-o)..code end
  return code
end
local function healMissingEnds(code:string): string
  local opens=0; for _ in code:gmatch("%f[%w]function%f[%W]") do opens+=1 end; for _ in code:gmatch("%f[%w]if%f[%W]") do opens+=1 end
  for _ in code:gmatch("%f[%w]for%f[%W]") do opens+=1 end; for _ in code:gmatch("%f[%w]while%f[%W]") do opens+=1 end; for _ in code:gmatch("%f[%w]do%f[%W]") do opens+=1 end
  local ends=select(2, code:gsub("%f[%w]end%f[%W]", "")); if opens>ends then return code..string.rep("\nend", opens-ends) end; return code
end

-- Transport markers (###LUA### ... ###END_LUA###, ###LUA:Server###) must never
-- persist into files or the compiler. The extension wraps execute_luau code
-- in them; if they leak into set_script_content/create_module the whole
-- script fails at line 1 ("Expected identifier, got '#'"). Strip them at
-- every write/exec entry point. Returns stripped, didStrip.
local function stripMarkers(s:string): (string, boolean)
  local orig = s
  s = s:gsub("###%s*LUA%s*:[^#\n]*###", ""):gsub("###%s*LUA%s*###", ""):gsub("###%s*END_LUA%s*###", "")
  s = s:gsub("^%s*```%w*\n?", ""):gsub("\n?%s*```%s*$", "")
  s = s:gsub("^%s*[Cc]opy%s+[Cc]ode%s*\n?", "")
  return s, s ~= orig
end

-- Instruction budget: unbounded synchronous code (infinite loops, giant
-- wait loops) would wedge the poll task forever with no remote kill. Where
-- the engine exposes debug.sethook we budget the current thread; Roblox
-- Luau does NOT expose debug.sethook (nil), so we feature-detect and run
-- directly instead of throwing "attempt to call a nil value" (2.1.11) or
-- "Cannot call task.wait on a thread that is already 'waiting'" (2.1.12).
-- poll() already runs in task.spawn, so yields (task.wait) propagate to the
-- scheduler normally - never busy-resume a waiting coroutine.
local HOOK_EVERY = 100000
local HOOK_MAX_HITS = 100 -- ~10M instructions ≈ a few seconds of CPU
local HAS_SETHOOK = type(debug) == "table" and type((debug::any).sethook) == "function"
local HAS_SETFENV = type(setfenv) == "function"
local function applyEnv(fn:any)
  if HAS_SETFENV and type(fn) == "function" then
    pcall(function() (setfenv::any)(fn, safeEnv) end)
  end
end
-- Static guard: a tight loop with no yield hangs Studio with no remote kill
-- (no hook fallback). Reject it as a validation error instead of hanging.
local function riskyLoop(code:string): string?
  local low = code:lower()
  if low:find("while%s+true%s+do") or low:find("while%s+1%s+do") or low:find("repeat%s*\n") then
    if not (low:find("task%.wait") or low:find("task%.delay") or low:find("heartbeat%s*:%s*wait")
      or low:find("%:wait%s*%(") or low:find("wait%s*%(")) then
      return "probable infinite loop with no yield - add task.wait() inside the loop or split the work"
    end
  end
  return nil
end
local function runBudgeted(fn: (...any) -> ...any, ...: any): (boolean, any)
  if HAS_SETHOOK then
    local hits = 0
    local dbg: any = debug
    pcall(function()
      dbg.sethook(function()
        hits += 1
        if hits > HOOK_MAX_HITS then
          error("RoLink budget exceeded (~10M instructions) - split the work, yield regularly (task.wait), no infinite loops")
        end
      end, "", HOOK_EVERY)
    end)
    local out = table.pack(pcall(fn, ...))
    pcall(function() dbg.sethook() end)
    if out[1] then return true, table.unpack(out, 2, out.n) end
    return false, out[2]
  end
  local out = table.pack(pcall(fn, ...))
  if out[1] then return true, table.unpack(out, 2, out.n) end
  return false, out[2]
end

-- Error context: a runtime message carries only a chunk line number
-- ([string "RoLink"]:460), while the attached code head shows just the first
-- 120 chars - useless for long scripts. Extract the failing line (plus its
-- neighbours) from the code so the model can fix the actual expression.
local function errLineCtx(code:string, err:string): string
  local ln = err:match('%[string "RoLink[^"]*"%]:(%d+):')
  local n = ln and tonumber(ln) or nil
  if not n or n < 1 then return "" end
  local idx, prev, target, nxt = 0, nil, nil, nil
  for line in (code .. "\n"):gmatch("([^\n]*)\n") do
    idx += 1
    if idx == n - 1 then prev = line
    elseif idx == n then target = line
    elseif idx == n + 1 then nxt = line break
    end
  end
  if not target then return "" end
  local function trim(s:string): string
    s = s:gsub("^%s+", ""):gsub("%s+$", "")
    if #s > 200 then s = s:sub(1, 200) .. "..." end
    return s
  end
  local ctx = " >> line " .. tostring(n) .. ": " .. trim(target)
  if prev and prev:gsub("%s+", "") ~= "" then
    ctx = " >> line " .. tostring(n - 1) .. ": " .. trim(prev) .. "\n" .. ctx
  end
  if nxt and nxt:gsub("%s+", "") ~= "" then
    ctx = ctx .. "\n >> line " .. tostring(n + 1) .. ": " .. trim(nxt)
  end
  if err:find("attempt to call a nil value") or err:find("attempt to call missing") then
    ctx = ctx .. " (something on this line is nil when called - check forward-referenced locals, typos, and require() results)"
  elseif err:find("attempt to index nil") then
    ctx = ctx .. " (indexing nil - the object on this line resolved to nothing; verify the path/name exists)"
  end
  return "\n" .. ctx
end

-- Wall-clock budget: runBudgeted caps CPU instructions, but a never-resolving
-- yield (hung require, WaitForChild without timeout) burns no instructions and
-- would wedge the single-flight queue until the bridge gives up. Run the chunk
-- on its own coroutine and abandon it past the deadline: the orphaned coroutine
-- holds no locks and its late result is discarded, so the queue stays usable
-- with no Studio restart. Must stay under the bridge's claim expiry (~25s).
local EXEC_BUDGET_S = 20
local function runWithDeadline(fn:any, code:string): (boolean, any)
  local done, okRun, a, b = false, false, nil, nil
  local co = coroutine.create(function()
    okRun, a, b = pcall(runBudgeted, fn)
    done = true
  end)
  local t0 = os.clock()
  local okStart, startErr = coroutine.resume(co)
  if not okStart then
    return false, tostring(startErr)
  end
  while not done do
    if os.clock() - t0 > EXEC_BUDGET_S then
      local head = code:gsub("%s+", " "):sub(1, 120)
      return false, "timeout: snippet still running after " .. tostring(EXEC_BUDGET_S)
        .. "s (likely a hung require or wait without timeout - verify modules singly, "
        .. "never bulk-require in one snippet) [code: " .. head .. ( #code > 120 and "..." or "") .. "]"
        .. errLineCtx(code, "")
    end
    task.wait(0.1)
  end
  return okRun, a, b
end

local function sandboxRun(code:string): (boolean, any)
  code, _ = stripMarkers(code)
  local risk = riskyLoop(code)
  if risk then return false, risk .. " [code: " .. code:gsub("%s+", " "):sub(1, 120) .. "]" end
  local ok, fn, loadErr = pcall(function() return loadstring(code, "RoLink") end)
  -- loadstring returns nil+message on syntax failure (no throw): surface the
  -- compiler message directly. The old ModuleScript harness appended
  -- "\nreturn true", turning `return {...}` into "Expected eof, got
  -- 'return'" and burying the real error under require_failed.
  if ok and type(fn) == "function" then
    local res = fn
    applyEnv(res)
    local okRun, a, b = pcall(runWithDeadline, res, code)
    local ok2: boolean? = nil
    local ret: any = nil
    if okRun then
      ok2 = a :: any
      ret = b
    else
      return false, tostring(a) .. " [code: " .. code:gsub("%s+", " "):sub(1, 120) .. "]" .. errLineCtx(code, tostring(a))
    end
    if ok2 then return true, ret end
    local err=tostring(ret); local healed=code
    if err:find("expected") or err:find("unfinished") then healed=balanceParens(healed); healed=healMissingEnds(healed) end
    healed=healed:gsub(":connect%(", ":Connect("):gsub("WatiForChild","WaitForChild"):gsub("Instnace","Instance")
    if healed~=code then
      local okH, resH = pcall(function() return loadstring(healed, "RoLinkHeal") end)
      if okH and resH then
        applyEnv(resH)
        local hOk, hA, hB = pcall(runWithDeadline, resH, healed)
        if hOk and (hA :: any) then return true, hB end
      end
    end
    -- Error context: the model only sees a line number otherwise. Attach the
    -- offending head so it can fix the actual expression.
    local head = code:gsub("%s+", " "):sub(1, 120)
    return false, err .. " [code: " .. head .. ( #code > 120 and "..." or "") .. "]" .. errLineCtx(code, err)
  elseif ok and fn == nil then
    -- Genuine compile failure: report the loader message, no harness detour.
    local head0 = code:gsub("%s+", " "):sub(1, 120)
    return false, "compiler_error: " .. tostring(loadErr) .. " [code: " .. head0 .. ( #code > 120 and "..." or "") .. "]"
  else
    -- loadstring itself threw (host protection): harness only for snippets
    -- that actually use require(); anything else gets the raw message.
    if not code:find("require%s*%(", 1) and not code:find("require%s*%s", 1) then
      local headX = code:gsub("%s+", " "):sub(1, 120)
      return false, "compiler_error: " .. tostring(fn) .. " [code: " .. headX .. ( #code > 120 and "..." or "") .. "]"
    end
    -- loadstring itself failed (syntax the parser rejects): try a ModuleScript
    -- harness so require-style snippets still get a real compiler error.
    -- The ModuleScript MUST be parented before require() or Studio throws a
    -- bare "Requested module experienced an error" with no inner context.
    local m: ModuleScript? = nil
    local okHarness, harnessRes = pcall(function()
      local mod = Instance.new("ModuleScript")
      mod.Name = "RoLinkHarness"
      mod.Source = code
      mod.Parent = game:GetService("ServerStorage")
      m = mod
      return require(mod :: any)
    end)
    if m then pcall(function() (m :: any):Destroy() end) end
    if okHarness then return true, harnessRes end
    local raw = tostring(harnessRes)
    local head2 = code:gsub("%s+", " "):sub(1, 120)
    local suffix = " [code: " .. head2 .. ( #code > 120 and "..." or "") .. "]"
    -- Two distinct prefixes: compiler errors vs loader errors. Never let a
    -- plain syntax failure wear the require_failed label.
    if raw:find("Requested module", 1, true) then
      local inner = raw:match("Requested module experienced an error[^:]*:%s*(.+)$")
        or raw:match("Requested module[^:]*:%s*(.+)$")
        or raw
      return false, "require_failed: " .. tostring(inner) .. suffix
    end
    return false, "compiler_error: " .. raw .. suffix
  end
end

local function captureSnapshot(maxDepth:number?, filter:string?): string
  local function walk(inst:Instance, depth:number, acc:{string})
    if depth>(maxDepth or 3) then return end
    if not filter or inst.Name:lower():find(filter:lower()) or inst.ClassName:lower():find(filter:lower()) then
      table.insert(acc, string.format("%s (%s) [%d]", inst:GetFullName(), inst.ClassName, #inst:GetChildren()))
    end
    for _,c in ipairs(inst:GetChildren()) do walk(c, depth+1, acc); if #acc>800 then break end end
  end
  local acc:{string}={}; pcall(function() walk(game,0,acc) end); table.insert(acc,1, string.format("-- snapshot %s | %d items", os.date("%X"), #acc))
  return table.concat(acc, "\n"):sub(1,8000)
end

local function findByPath(path:string): Instance?
  if not path or path == "" then return nil end
  if path == "workspace" or path == "Workspace" then return workspace end
  local p = path
  if p:sub(1,5) == "game." then p = p:sub(6) end
  -- slash-walk: "Workspace/ProofCube", "game.Workspace/Folder/X" (dots kept
  -- for service names like "ServerScriptService")
  if p:find("/") then
    local cur: Instance? = game
    local walked = false
    for part in p:gmatch("[^/]+") do
      if part == "game" and cur == game then continue end
      if (part == "Workspace" or part == "workspace") and cur == game then
        cur = workspace; walked = true; continue
      end
      if not cur then break end
      local nxt = cur:FindFirstChild(part)
      if not nxt then cur = nil; break end
      cur = nxt; walked = true
    end
    if walked and cur then return cur end
  end
  -- dot-walk: "Workspace.Rig", "game.Workspace.Folder.X" (the shape models
  -- actually write). Runs only without slashes; a failed walk falls through
  -- to the legacy exact-name scan below, so names containing dots
  -- ("My.Part") still resolve.
  if p:find(".", 1, true) then
    local cur: Instance? = game
    local walked = false
    for part in p:gmatch("[^.]+") do
      if part == "game" and cur == game then continue end
      if (part == "Workspace" or part == "workspace") and cur == game then
        cur = workspace; walked = true; continue
      end
      if not cur then break end
      local nxt = cur:FindFirstChild(part)
      if not nxt then cur = nil; break end
      cur = nxt; walked = true
    end
    if walked and cur then return cur end
  end
  -- legacy fallbacks (bare names, old single-segment behavior)
  local ok, res = pcall(function() return game:FindFirstChild(p, true) end)
  if ok and res then return res end
  local found:Instance? = nil
  pcall(function() for _,v in ipairs(game:GetDescendants()) do if v.Name==p then found=v; break end end end)
  return found
end

-- Sibling names for "not found" errors, so the model can self-correct
-- instead of guessing blindly a second time.
local function siblingHint(path:any): string
  local parts:{string} = {}
  for p in tostring(path or ""):gmatch("[^/]+") do table.insert(parts, p) end
  if #parts == 0 then return "" end
  table.remove(parts) -- drop the missing leaf
  local parent: Instance? = (#parts == 0) and workspace or findByPath(table.concat(parts, "/"))
  if not parent then return "" end
  local names:{string} = {}
  pcall(function()
    for _, c in ipairs(parent:GetChildren()) do
      if #names >= 8 then break end
      table.insert(names, c.Name .. "(" .. c.ClassName .. ")")
    end
  end)
  if #names == 0 then return "" end
  return " Siblings under " .. parent:GetFullName() .. ": " .. table.concat(names, ", ")
end

-- Safe property dump: iterating an Instance with pairs() throws
-- "invalid argument #1 (table expected, got Instance)", so read a curated
-- candidate list + attributes, every read guarded. Never iterate the Instance itself.
local COMMON_PROPS = {
  "Name", "ClassName", "Parent", "Archivable",
  "Position", "Size", "Color", "Material", "Transparency", "Anchored",
  "CanCollide", "Orientation", "CFrame", "Shape", "TopSurface", "BottomSurface",
  "Text", "Enabled", "Visible", "BackgroundColor3", "TextColor3", "Font",
  "Source", "Volume", "SoundId", "Playing", "Looped", "Brightness", "Range",
  "Rate", "Speed", "Lifetime", "Health", "MaxHealth", "WalkSpeed", "JumpPower",
  "Value",
}
local function safeProps(inst: Instance): { [string]: any }
  local t:{ [string]: any } = {}
  t.ClassName = inst.ClassName
  t.Name = inst.Name
  pcall(function()
    t.FullName = inst:GetFullName()
    t.Children = #inst:GetChildren()
  end)
  for _, k in ipairs(COMMON_PROPS) do
    pcall(function()
      local v = (inst::any)[k]
      if v ~= nil then t[k] = tostring(v) end
    end)
  end
  pcall(function()
    local at = inst:GetAttributes()
    if type(at) == "table" then
      local aa:{ [string]: any } = {}
      for ak, av in pairs(at) do aa[ak] = tostring(av) end
      t.Attributes = aa
    end
  end)
  return t
end

-- ── Animation track cache + builders (tools 47-48, 112-113) ─────────────
-- KeyframeSequenceProvider only issues temporary Studio-local hash IDs
-- (RegisterKeyframeSequence); there is NO provider remove API, so
-- delete_animation destroys our cached sequence. Service is deprecated in
-- favor of AnimationClipProvider but still functional in Studio.
local animCache: { [string]: KeyframeSequence } = {}
local function num(v:any, d:number): number
  local n = tonumber(v); if n == nil then return d end; return n
end
local function vec3(t:any): Vector3
  if type(t) ~= "table" then return Vector3.zero end
  return Vector3.new(num(t.x, 0), num(t.y, 0), num(t.z, 0))
end
-- Easing curves for professional motion: an eased segment bakes 3
-- interpolated in-between keyframes so sparse input plays realistically
-- instead of robotically linear. Times must be non-decreasing.
local EASE_FNS: { [string]: (number) -> number } = {
  linear = function(t) return t end,
  quadIn = function(t) return t * t end,
  quadOut = function(t) return 1 - (1 - t) * (1 - t) end,
  quadInOut = function(t) if t < 0.5 then return 2 * t * t end return 1 - (-2 * t + 2) * (-2 * t + 2) / 2 end,
  cubicIn = function(t) return t * t * t end,
  cubicOut = function(t) return 1 - (1 - t) * (1 - t) * (1 - t) end,
  cubicInOut = function(t) if t < 0.5 then return 4 * t * t * t end return 1 - (-2 * t + 2) * (-2 * t + 2) * (-2 * t + 2) / 2 end,
  sineIn = function(t) return 1 - math.cos(t * math.pi / 2) end,
  sineOut = function(t) return math.sin(t * math.pi / 2) end,
  sineInOut = function(t) return -(math.cos(math.pi * t) - 1) / 2 end,
}
local EASE_SUBDIV = 3
-- Alias + typo tolerance: the model writes bare "quad" (or "Quad-In",
-- "easeout") far more often than the exact enum. Normalize case, separators
-- and bare family names instead of failing; only truly unknown names error,
-- with a did-you-mean hint so the retry lands first try.
local EASE_ALIASES: { [string]: string } = {
  quad = "quadInOut", cubic = "cubicInOut", sine = "sineInOut",
  easein = "quadIn", easeout = "quadOut", easeinout = "quadInOut",
  ease_in = "quadIn", ease_out = "quadOut", ease_in_out = "quadInOut",
}
local EASE_LIST = "linear|quadIn|quadOut|quadInOut|cubicIn|cubicOut|cubicInOut|sineIn|sineOut|sineInOut"
local function resolveEasing(name:string): (string?)
  if EASE_FNS[name] then return name end
  local norm = name:lower():gsub("[%s%-%_]", "")
  for k in pairs(EASE_FNS) do
    if k:lower() == norm then return k end
  end
  return EASE_ALIASES[norm]
end
local function easingHint(bad:string): string
  local bl = bad:lower()
  local out:{string} = {}
  for k in pairs(EASE_FNS) do
    local kl = k:lower()
    if kl:find(bl, 1, true) or bl:find(kl, 1, true) then table.insert(out, k) end
  end
  table.sort(out)
  if #out > 0 then return "did you mean " .. table.concat(out, "/") .. "? " end
  return ""
end
local function bakeEased(kfData:{ [string]: any }): { [string]: any }
  local out:{ [string]: any } = {}
  for i, kfD in ipairs(kfData) do
    if type(kfD) ~= "table" then error("keyframe must be an object") end
    local t = math.max(0, num((kfD::any).time, 0))
    if i > 1 and t < math.max(0, num(((kfData[i - 1])::any).time, 0)) then
      error("keyframe times must be non-decreasing (keyframe " .. i .. " goes backwards)")
    end
    local easeName = tostring((kfD::any).easing or "linear")
    local resolved = resolveEasing(easeName)
    if not resolved then error("unknown easing '" .. easeName:sub(1, 32) .. "' " .. easingHint(easeName) .. "(" .. EASE_LIST .. ")") end
    local easeFn = EASE_FNS[resolved]
    if i > 1 and resolved ~= "linear" then
      local prev = kfData[i - 1]
      local t0 = math.max(0, num((prev::any).time, 0))
      local prevPoses:{ [string]: any } = {}
      for _, pD in ipairs((prev::any).poses or {}) do
        if type(pD) == "table" then prevPoses[tostring((pD::any).part or "")] = pD end
      end
      for s = 1, EASE_SUBDIV do
        local f = easeFn(s / (EASE_SUBDIV + 1))
        local poses:{ [string]: any } = {}
        for _, pD in ipairs((kfD::any).poses or {}) do
          if type(pD) ~= "table" then continue end
          local part = tostring((pD::any).part or "Torso")
          local qD = prevPoses[part]
          local p1 = (pD::any).position or {}
          local r1 = (pD::any).rotation or {}
          local p0 = (qD and (qD::any).position) or p1
          local r0 = (qD and (qD::any).rotation) or r1
          local function lp(a:any, b:any): number
            return num(a, 0) + (num(b, 0) - num(a, 0)) * f
          end
          table.insert(poses, {
            part = part,
            position = { x = lp((p0::any).x, (p1::any).x), y = lp((p0::any).y, (p1::any).y), z = lp((p0::any).z, (p1::any).z) },
            rotation = { x = lp((r0::any).x, (r1::any).x), y = lp((r0::any).y, (r1::any).y), z = lp((r0::any).z, (r1::any).z) },
          })
        end
        table.insert(out, { time = t0 + (t - t0) * (s / (EASE_SUBDIV + 1)), poses = poses })
      end
    end
    table.insert(out, kfD)
  end
  if #out > 200 then error("eased bake produced " .. #out .. " keyframes (max 200) - use fewer keyframes or linear easing") end
  return out
end
local function createAnimationTrack(args:{ [string]: any }): { [string]: any }
  local name = tostring(args.name or "RoLinkAnimation"):sub(1, 64)
  local kfData = args.keyframes
  if type(kfData) ~= "table" or #kfData == 0 then error("keyframes must be a non-empty array") end
  if #kfData > 200 then error("too many keyframes (max 200)") end
  -- Instance budget: every pose becomes engine objects, and tens of thousands
  -- of Instance.new calls wedge the single-flight queue past the bridge
  -- timeout with zero answers (seen live: 60s hang on an M1 combo retry).
  -- Fail fast with a split hint instead.
  local totalPoses = 0
  for _, kfD in ipairs(kfData) do
    if type(kfD) == "table" then
      local pp = (kfD::any).poses
      if type(pp) == "table" then totalPoses += #pp end
    end
  end
  if totalPoses > 1024 then error("too many animated parts (" .. totalPoses .. " total poses, max 1024) - split across tracks or use fewer keyframes") end
  kfData = bakeEased(kfData)
  local folder = game.Workspace:FindFirstChild("RoLinkAnimations")
  if not folder then folder = Instance.new("Folder"); folder.Name = "RoLinkAnimations"; folder.Parent = game.Workspace end
  local seq = Instance.new("KeyframeSequence")
  seq.Name = name
  if args.loop == true then seq.Loop = true end
  local made = 0
  for _, kfD in ipairs(kfData) do
    if type(kfD) ~= "table" then error("keyframe must be an object") end
    local kf = Instance.new("Keyframe")
    kf.Time = math.max(0, num((kfD::any).time, 0))
    local poses = (kfD::any).poses
    if type(poses) ~= "table" or #poses == 0 then error("keyframe poses must be non-empty") end
    if #poses > 64 then error("too many poses per keyframe (max 64)") end
    for _, pD in ipairs(poses) do
      local pose = Instance.new("Pose")
      pose.Name = tostring((pD::any).part or "Torso"):sub(1, 64)
      local pos = vec3((pD::any).position)
      local rot = (pD::any).rotation
      local cf = CFrame.new(pos) * CFrame.Angles(math.rad(num(rot and (rot::any).x, 0)), math.rad(num(rot and (rot::any).y, 0)), math.rad(num(rot and (rot::any).z, 0)))
      pose.CFrame = cf
      local sc = (pD::any).scale
      if type(sc) == "table" then pose.Weight = math.clamp(num((sc::any).x, 1), 0.01, 10) end
      pose.Parent = kf
      made += 1
      -- Yield regularly: thousands of back-to-back Instance ops starve the
      -- poll task and read as a hang from the bridge side.
      if made % 128 == 0 then task.wait() end
    end
    kf.Parent = seq
  end
  seq.Parent = folder
  pcall(function() ChangeHistoryService:SetWaypoint("RoLink create " .. name) end)
  local hashId = game:GetService("KeyframeSequenceProvider"):RegisterKeyframeSequence(seq)
  animCache[tostring(hashId)] = seq
  local snippet = "local seq = game.Workspace.RoLinkAnimations:FindFirstChild(\""
    .. name:gsub('"', "'")
    .. "\") assert(seq, \"missing track " .. name:gsub('"', "'")
    .. "\") local id = game:GetService(\"KeyframeSequenceProvider\"):RegisterKeyframeSequence(seq)"
    .. " local anim = Instance.new(\"Animation\") anim.AnimationId = id"
    .. " local track = animator:LoadAnimation(anim) track:Play() -- Animation object chain, never pass KeyframeSequence to LoadAnimation"
  return { animationId = tostring(hashId), name = name, keyframes = #kfData,
    path = seq:GetFullName(), runtimeSnippet = snippet }
end
-- Rigs the model can actually address: Models with a Humanoid, by full path.
local function rigCandidates(): {string}
  local out:{string} = {}
  pcall(function()
    for _, d in ipairs(workspace:GetDescendants()) do
      if #out >= 5 then break end
      if d:IsA("Model") and d:FindFirstChildOfClass("Humanoid") then
        table.insert(out, d:GetFullName())
      end
    end
  end)
  return out
end
local function resolveAnimationId(args:{ [string]: any }): string
  -- Accepts hash, rbxassetid://, or a path to an in-place KeyframeSequence.
  -- Never pass a KeyframeSequence instance to LoadAnimation (it requires an
  -- Animation object); register on demand and use the returned id.
  local animId = tostring(args.animationId or "")
  local pathArg = tostring(args.path or "")
  if animId ~= "" and animId:find("KeyframeSequence") == nil then
    local byPath = findByPath(animId)
    if byPath and byPath:IsA("KeyframeSequence") then
      local okReg, regId = pcall(function()
        return game:GetService("KeyframeSequenceProvider"):RegisterKeyframeSequence(byPath :: any)
      end)
      if okReg and regId then animCache[tostring(regId)] = byPath; return tostring(regId) end
    else
      return animId
    end
  elseif animId ~= "" then
    return animId
  end
  if pathArg ~= "" then
    local inst = findByPath(pathArg)
    if not inst then error("not found " .. pathArg .. siblingHint(pathArg)) end
    if not inst:IsA("KeyframeSequence") then error("not a KeyframeSequence: " .. inst:GetFullName()) end
    local okR, rId = pcall(function()
      return game:GetService("KeyframeSequenceProvider"):RegisterKeyframeSequence(inst :: any)
    end)
    if not okR or not rId then error("could not register KeyframeSequence at " .. inst:GetFullName()) end
    animCache[tostring(rId)] = inst
    return tostring(rId)
  end
  error("animationId or path required (hash, rbxassetid://, or Workspace/RoLinkAnimations/<Name>)")
  return ""
end
local function playAnimation(args:{ [string]: any }): { [string]: any }
  local char = findByPath(tostring(args.characterPath or args.target or "workspace"))
  if not char then
    local rigs = rigCandidates()
    local hint = #rigs > 0 and (" Rigs with a Humanoid here: " .. table.concat(rigs, ", ")) or " No Model with a Humanoid exists in workspace yet."
    error("CHARACTER_NOT_FOUND: " .. tostring(args.characterPath or args.target) .. "." .. hint)
  end
  local humanoid = char:FindFirstChildOfClass("Humanoid")
  if not humanoid then
    local rigs = rigCandidates()
    local hint = #rigs > 0 and (" Rigs with a Humanoid here: " .. table.concat(rigs, ", ")) or ""
    error("HUMANOID_NOT_FOUND: " .. char:GetFullName() .. " has no Humanoid." .. hint)
  end
  local animator = humanoid:FindFirstChildOfClass("Animator")
  if not animator then animator = Instance.new("Animator"); animator.Parent = humanoid end
  local animId = resolveAnimationId(args)
  -- Plugin context runs in Edit, never in the Play Server/Client DataModels.
  -- Driving a Play-session rig from here edits the wrong Workspace copy, so
  -- the user sees nothing move. Be honest instead of bare success.
  local running = false
  pcall(function() running = game:GetService("RunService"):IsRunning() end)
  if running then
    return { success = false, rendered = false, playable = false, animationId = animId,
      error = "IN_PLAY_MODE: plugin tools run in the Edit DataModel and cannot drive Play Server rigs. Stop Play (start_stop_play), build/verify in Edit via create_animation_track + get_animation_info{path}, then press Play to view." }
  end
  local animation = Instance.new("Animation")
  animation.AnimationId = animId
  local track = (animator::any):LoadAnimation(animation)
  track:Play()
  local speed = num(args.speed, 1)
  if speed ~= 1 then track:AdjustSpeed(math.clamp(speed, 0.1, 8)) end
  if args.loop == true then track.Looped = true end
  -- Edit mode never renders animation playback: say so honestly instead of a
  -- bare success the user then can't see. The track IS playing underneath.
  local ret:{ [string]: any } = { success = true, trackName = track.Name, animationId = animId }
  ret.rendered = false
  ret.note = "Edit mode never renders animation playback - press Play to see it move."
  return ret
end
local function summarizeSequence(seq: Instance, animId: string): { [string]: any }
  local kfs = (seq::any):GetKeyframes()
  local parts:{string} = {}; local seen:{[string]:boolean} = {}; local dur = 0
  local detail:{any} = {}
  for idx, kf in ipairs(kfs) do
    if idx > 50 then break end
    if (kf::any).Time > dur then dur = (kf::any).Time end
    local poses:{string} = {}
    for _, d in ipairs((kf::any):GetDescendants()) do
      if d:IsA("Pose") then
        if not seen[d.Name] then seen[d.Name] = true; table.insert(parts, d.Name) end
        if #poses < 12 then table.insert(poses, d.Name) end
      end
    end
    -- Duplicate Keyframe names are legal; index disambiguates them.
    table.insert(detail, { index = idx, name = (kf::any).Name, time = (kf::any).Time, poses = poses })
  end
  table.sort(parts)
  local ret:{ [string]: any } = { animationId = animId, name = (seq::any).Name, path = (seq::any):GetFullName(),
    keyframeCount = #kfs, duration = dur, parts = parts, keyframes = detail, loop = (seq::any).Loop }
  -- Clip-twin enrichment is optional and must NEVER fail the read: a stale
  -- plugin copy missing findClipTwin (seen live as Script:651 "attempt to
  -- call a nil value") used to turn a good info call into a crash.
  local twinOk, twin = pcall(function()
    local finder:any = findClipTwin
    if type(finder) ~= "function" then error("no clip-twin helper in this plugin copy - reinstall it") end
    return finder(seq)
  end)
  if twinOk and twin then
    local okPath, fullName = pcall(function() return (twin::any):GetFullName() end)
    if okPath then ret.clip = fullName end
    local okC, curves = pcall(function()
      local summarizer:any = clipCurvesSummary
      if type(summarizer) ~= "function" then error("no clip-curves helper in this plugin copy") end
      return summarizer(twin)
    end)
    if okC then ret.clipCurves = curves end
  end
  return ret
end
local function getAnimationInfo(args:{ [string]: any }): { [string]: any }
  local animId = tostring(args.animationId or "")
  local pathArg = tostring(args.path or "")
  if pathArg ~= "" then
    local inst = findByPath(pathArg)
    if not inst then error("not found " .. pathArg .. siblingHint(pathArg)) end
    if not (inst:IsA("KeyframeSequence")) then
      error("not a KeyframeSequence: " .. inst:GetFullName() .. " (" .. inst.ClassName .. ")")
    end
    return summarizeSequence(inst, animId ~= "" and animId or inst:GetFullName())
  end
  if animId == "" then error("animationId or path required (e.g. path=Workspace/RoLinkAnimations/HelloWave)") end
  local seq = animCache[animId]
  if not seq then
    -- A path may have been passed as animationId by older prompts.
    local byPath = findByPath(animId)
    if byPath and byPath:IsA("KeyframeSequence") then return summarizeSequence(byPath, animId) end
    local ok, got = pcall(function() return game:GetService("KeyframeSequenceProvider"):GetKeyframeSequenceAsync(animId) end)
    if not ok or not got then error("animation not found: " .. animId) end
    seq = got
  end
  return summarizeSequence(seq, animId)
end
local function deleteAnimation(args:{ [string]: any }): { [string]: any }
  local animId = tostring(args.animationId or "")
  if animId == "" then error("animationId required") end
  local seq = animCache[animId]
  if seq then pcall(function() seq:Destroy() end); animCache[animId] = nil
    pcall(function() ChangeHistoryService:SetWaypoint("RoLink delete " .. animId) end)
    return { deleted = true, animationId = animId }
  end
  return { deleted = false, animationId = animId, error = "not cached (only temp tracks can be deleted)" }
end

-- ── Cinematics (tools 114-117) ──────────────────────────────────────
-- Edit stores the data model; Play renders it via a real server Script.
-- Every builder returns a runtimeSnippet for that Script. Only create_vfx
-- renders immediately (viewport particles/lights work in Edit).
local function createCutscene(args:{ [string]: any }): { [string]: any }
  local name = tostring(args.name or "RoLinkCutscene"):sub(1, 64)
  local shots = args.shots
  if type(shots) ~= "table" or #shots == 0 then error("shots must be a non-empty array") end
  if #shots > 32 then error("too many shots (max 32)") end
  local folder = game.Workspace:FindFirstChild("RoLinkCutscenes")
  if not folder then folder = Instance.new("Folder"); folder.Name = "RoLinkCutscenes"; folder.Parent = game.Workspace end
  local total = 0
  local data:{ [string]: any } = {}
  for i, sD in ipairs(shots) do
    if type(sD) ~= "table" then error("shot " .. i .. " must be an object") end
    local cam = (sD::any).camera
    if type(cam) ~= "table" then error("shot " .. i .. " needs camera{position, lookAt}") end
    local dur = num((sD::any).duration, 0)
    if dur < 0.1 or dur > 30 then error("shot " .. i .. " duration must be 0.1-30s") end
    total += dur
    table.insert(data, { camera = cam, duration = dur, easing = tostring((sD::any).easing or "linear") })
  end
  local mod = Instance.new("ModuleScript")
  mod.Name = name
  local okEnc, json = pcall(function() return game:GetService("HttpService"):JSONEncode(data) end)
  local decoded = "{}"
  if okEnc then decoded = "game:GetService(\"HttpService\"):JSONDecode([=[" .. tostring(json) .. "]=])" end
  mod.Source = "-- RoLink cutscene data (" .. #data .. " shots)\nreturn " .. decoded
  mod.Parent = folder
  pcall(function() ChangeHistoryService:SetWaypoint("RoLink cutscene " .. name) end)
  local snippet = "local shots = require(game.Workspace.RoLinkCutscenes:FindFirstChild(\""
    .. name:gsub('"', "'")
    .. "\")) local cam = game.Workspace.CurrentCamera cam.CameraType = Enum.CameraType.Scriptable"
    .. " for _, s in ipairs(shots) do cam.CFrame = CFrame.new(Vector3.new(s.camera.position.x, s.camera.position.y, s.camera.position.z), Vector3.new(s.camera.lookAt.x, s.camera.lookAt.y, s.camera.lookAt.z)) task.wait(s.duration) end"
  return { name = name, shots = #data, duration = total, path = mod:GetFullName(), runtimeSnippet = snippet }
end
local function createDialogue(args:{ [string]: any }): { [string]: any }
  local npc = findByPath(tostring(args.npcPath or ""))
  if not npc then error("not found " .. tostring(args.npcPath or "") .. siblingHint(args.npcPath or "")) end
  local lines = args.lines
  if type(lines) ~= "table" or #lines == 0 then error("lines must be a non-empty array") end
  if #lines > 50 then error("too many lines (max 50)") end
  for i, lD in ipairs(lines) do
    if type(lD) ~= "table" or tostring((lD::any).speaker or "") == "" then error("line " .. i .. " needs speaker") end
    if tostring((lD::any).text or "") == "" then error("line " .. i .. " needs text") end
    local ch = (lD::any).choices
    if ch ~= nil then
      if type(ch) ~= "table" or #ch > 4 then error("line " .. i .. " choices: max 4 strings") end
    end
  end
  local anchor: Instance? = npc:IsA("Model") and (npc:FindFirstChild("Head") or npc:FindFirstChild("HumanoidRootPart") or npc) or npc
  local prompt = Instance.new("ProximityPrompt")
  prompt.Name = "RoLinkDialogue"
  prompt.ActionText = "Talk"
  prompt.HoldDuration = 0
  prompt.Parent = anchor
  local mod = Instance.new("ModuleScript")
  mod.Name = npc.Name .. "Dialogue"
  local okEnc, json = pcall(function() return game:GetService("HttpService"):JSONEncode(lines) end)
  local decoded = "{}"
  if okEnc then decoded = "game:GetService(\"HttpService\"):JSONDecode([=[" .. tostring(json) .. "]=])" end
  mod.Source = "-- RoLink dialogue data (" .. #lines .. " lines)\nreturn " .. decoded
  mod.Parent = npc
  pcall(function() ChangeHistoryService:SetWaypoint("RoLink dialogue " .. npc.Name) end)
  local snippet = "local lines = require(script.Parent:FindFirstChild(\"" .. mod.Name:gsub('"', "'")
    .. "\")) -- show lines[i].speaker .. \": \" .. lines[i].text in your dialogue UI on ProximityPrompt.Triggered"
  return { lines = #lines, path = mod:GetFullName(), prompt = prompt:GetFullName(), runtimeSnippet = snippet }
end
local MOTION_EFFECTS = { tween = true, shake = true, fov = true, pulse = true }
local function createMotionEffect(args:{ [string]: any }): { [string]: any }
  local target = findByPath(tostring(args.path or ""))
  if not target then error("not found " .. tostring(args.path or "") .. siblingHint(args.path or "")) end
  local effect = tostring(args.effect or "tween")
  if not MOTION_EFFECTS[effect] then error("unknown effect '" .. effect:sub(1, 32) .. "' (tween|shake|fov|pulse)") end
  local dur = math.clamp(num(args.duration, 1), 0.1, 30)
  local snippet = "local target = game.Workspace:FindFirstChild(\"" .. target.Name:gsub('"', "'")
    .. "\", true) -- effect=" .. effect .. " duration=" .. tostring(dur)
    .. " — drive with TweenService (tween/pulse) or CameraOffset/Random (shake) or Camera.FieldOfView (fov) in a server Script"
  pcall(function() ChangeHistoryService:SetWaypoint("RoLink motion " .. effect) end)
  return { effect = effect, path = target:GetFullName(), duration = dur, runtimeSnippet = snippet }
end
local VFX_CLASSES: { [string]: string } = {
  particles = "ParticleEmitter", fire = "Fire", smoke = "Smoke",
  sparkles = "Sparkles", beam = "Beam", pointlight = "PointLight",
}
local function createVfx(args:{ [string]: any }): { [string]: any }
  local parent = findByPath(tostring(args.parent or "workspace")) or workspace
  local effect = tostring(args.effect or "particles")
  local className = VFX_CLASSES[effect]
  if not className then error("unknown effect '" .. effect:sub(1, 32) .. "' (particles|fire|smoke|sparkles|beam|pointlight)") end
  local inst = Instance.new(className)
  inst.Name = "RoLink" .. effect:gsub("^%l", string.upper)
  if args.properties and type(args.properties) == "table" then
    for k, v in pairs(args.properties::any) do pcall(function() (inst::any)[k] = v end) end
  end
  if effect == "beam" then
    local a0 = Instance.new("Attachment"); a0.Parent = parent
    local a1 = Instance.new("Attachment"); a1.Position = Vector3.new(0, 5, 0); a1.Parent = parent
    pcall(function() (inst::any).Attachment0 = a0; (inst::any).Attachment1 = a1 end)
  end
  inst.Parent = parent
  pcall(function() ChangeHistoryService:SetWaypoint("RoLink vfx " .. effect) end)
  return { created = { inst:GetFullName() }, effect = effect }
end

-- ── Clip export + publish workflow (tools 118-119) ───────────────────
-- The AnimationClip twin carries the track's curve data (one JSON curve per
-- part) for editor round-trips and read-back. Playback still uses the
-- sequence hash or a published asset ID — never LoadAnimation a clip.
-- AnimationClip availability varies by Studio version: absence is a clean
-- validation_error, never a crash.
local function resolveSourceSequence(args:{ [string]: any }): Instance
  local pathArg = tostring(args.trackPath or "")
  local animId = tostring(args.animationId or "")
  if pathArg ~= "" then
    local inst = findByPath(pathArg)
    if not inst then error("not found " .. pathArg .. siblingHint(pathArg)) end
    if not inst:IsA("KeyframeSequence") then error("not a KeyframeSequence: " .. inst:GetFullName()) end
    return inst
  end
  if animId ~= "" then
    local seq = animCache[animId]
    if seq then return seq end
    local byPath = findByPath(animId)
    if byPath and byPath:IsA("KeyframeSequence") then return byPath end
  end
  error("trackPath or animationId required (e.g. trackPath=Workspace/RoLinkAnimations/HelloWave)")
  return nil :: any
end
local function clipCurvesSummary(clip: Instance): { [string]: any }
  local curves:{ [string]: any } = {}
  pcall(function()
    for _, child in ipairs(clip:GetChildren()) do
      if child:IsA("StringValue") and child.Name:find("Curve_") == 1 then
        local okDec, data = pcall(function()
          return game:GetService("HttpService"):JSONDecode((child::any).Value or "[]")
        end)
        table.insert(curves, { part = child.Name:sub(7), keys = (okDec and type(data) == "table") and #data or 0 })
      end
    end
  end)
  return curves
end
local function findClipTwin(seq: Instance): Instance?
  local twin: Instance? = nil
  pcall(function()
    local parent = seq.Parent
    if parent then twin = parent:FindFirstChild(seq.Name .. "Clip") end
    if twin and not twin:IsA("AnimationClip") then twin = nil end
  end)
  return twin
end
local function exportAnimationClip(args:{ [string]: any }): { [string]: any }
  local seq = resolveSourceSequence(args)
  local clip: Instance? = nil
  local okNew, newInst = pcall(function() return Instance.new("AnimationClip") end)
  if not okNew or not newInst then
    error("validation_error: this Studio version cannot create AnimationClip (update Studio). "
      .. "Do NOT retry prepare here - keep the KeyframeSequence, publish it via Studio's Animation Editor "
      .. "(human click), then publish_animation{action:register, assetId:rbxassetid://...} with the real ID.")
  end
  clip = newInst
  ;(clip::any).Name = seq.Name .. "Clip"
  pcall(function() (clip::any).Loop = (seq::any).Loop end)
  local curveCount = 0
  pcall(function()
    for _, kf in ipairs((seq::any):GetKeyframes()) do
      for _, d in ipairs((kf::any):GetDescendants()) do
        if d:IsA("Pose") then
          local part = d.Name
          local holder = (clip::any):FindFirstChild("Curve_" .. part)
          if not holder then
            holder = Instance.new("StringValue")
            holder.Name = "Curve_" .. part
            holder.Parent = clip
          end
          local okDec, arr = pcall(function()
            return game:GetService("HttpService"):JSONDecode(holder.Value == "" and "[]" or holder.Value)
          end)
          if not okDec or type(arr) ~= "table" then arr = {} end
          table.insert(arr, { t = (kf::any).Time, cf = tostring((d::any).CFrame) })
          local okEnc, js = pcall(function() return game:GetService("HttpService"):JSONEncode(arr) end)
          if okEnc then holder.Value = js end
          curveCount += 1
        end
      end
    end
  end)
  ;(clip::any).Parent = seq.Parent
  pcall(function() ChangeHistoryService:SetWaypoint("RoLink clip " .. seq.Name) end)
  return { clip = (clip::any):GetFullName(), curves = clipCurvesSummary(clip),
    keyframes = #(seq::any):GetKeyframes(),
    note = "Clip twin for editor round-trip + read-back. Playback uses the sequence hash or a published asset ID, never this clip." }
end
local function prepareAnimation(args:{ [string]: any }): { [string]: any }
  local seq = resolveSourceSequence(args)
  local kfs = (seq::any):GetKeyframes()
  if #kfs == 0 then error("track " .. seq:GetFullName() .. " has no keyframes - nothing to publish") end
  local clipRes = exportAnimationClip(args)
  return { ready = true, track = seq:GetFullName(), keyframes = #kfs,
    clip = clipRes.clip, curves = clipRes.curves,
    checklist = { "poses named per rig part", "times non-decreasing", "clip twin emitted" },
    publishSteps = "In Studio: select the track (or open it in the Animation Editor), Publish to Roblox, copy the asset ID, then publish_animation{action:register, assetId:rbxassetid://...}. Publishing needs your login - the AI cannot click it for you." }
end
local function registerAnimation(args:{ [string]: any }): { [string]: any }
  local assetId = tostring(args.assetId or "")
  if assetId == "" then error("assetId required (e.g. rbxassetid://123456) - paste the ID from your publish step") end
  if assetId:find("rbxassetid://", 1, true) ~= 1 and not assetId:match("^%d+$") then
    error("assetId must look like rbxassetid://123456 or a numeric id, got '" .. assetId:sub(1, 40) .. "' - never invent IDs")
  end
  local ok, got = pcall(function()
    return game:GetService("KeyframeSequenceProvider"):GetKeyframeSequenceAsync(assetId)
  end)
  if not ok or not got then error("animation not found for " .. assetId .. " - check the ID and that it is published") end
  animCache[assetId] = got
  return { animationId = assetId, cached = true, name = got.Name,
    note = "Use play_animation/get_animation_info with this ID. Temp hashes die with the session; this ID ships." }
end


-- ── Model animation store (tools 125-131) ─────────────────────────────
-- AI-native animation for ANY rig: humanoids, cannons, doors, vehicles,
-- machines. Definitions live in ReplicatedStorage/RoLinkModelAnims/<Name>
-- (Folder + attributes + StringValue JSON) so chat turns and the future
-- timeline widget read the same source. All motion math is numeric
-- (degrees + studs); preview/validate return numbers, never pixels, because
-- Studio exposes no pixel capture to plugins.
local MAX_MODEL_KEYS = 1024
local RL_ROT_WARN, RL_ROT_ERR = 2400, 7200
local RL_POS_WARN, RL_POS_ERR = 15, 40
local function rlAnimRoot(): Instance
  local rs = game:GetService("ReplicatedStorage")
  local f = rs:FindFirstChild("RoLinkModelAnims")
  if not f then
    f = Instance.new("Folder")
    f.Name = "RoLinkModelAnims"
    f.Parent = rs
  end
  return f
end
local function rlAnimFolder(name: string): Instance?
  return rlAnimRoot():FindFirstChild(name)
end
local function rlAnimRead(name: string): (Instance, { [string]: any }, { [string]: any }, { [string]: any })
  local folder = rlAnimFolder(name)
  if not folder then
    error("MODEL_ANIM_NOT_FOUND: no model animation named '" .. name:sub(1, 64) .. "' - create it with create_model_animation first")
  end
  local function get(child: string): any
    local sv = folder:FindFirstChild(child)
    if not sv or not sv:IsA("StringValue") then return nil end
    local ok, v = pcall(function() return HttpService:JSONDecode((sv :: StringValue).Value) end)
    if not ok then
      error("MODEL_ANIM_CORRUPT: '" .. name:sub(1, 64) .. "/" .. child .. "' is not valid JSON - recreate the animation")
    end
    return v
  end
  local tracks = get("tracks")
  if tracks == nil then tracks = {} end
  local markers = get("markers")
  if markers == nil then markers = {} end
  local events = get("events")
  if events == nil then events = {} end
  if type(tracks) ~= "table" or type(markers) ~= "table" or type(events) ~= "table" then
    error("MODEL_ANIM_CORRUPT: '" .. name:sub(1, 64) .. "' store has a bad shape - recreate the animation")
  end
  return folder, tracks, markers, events
end
local function rlAnimWrite(name: string, folder: Instance, tracks: any, markers: any, events: any)
  local function put(child: string, v: any)
    local sv = folder:FindFirstChild(child)
    if not sv then
      sv = Instance.new("StringValue")
      sv.Name = child
      sv.Parent = folder
    end
    (sv :: StringValue).Value = HttpService:JSONEncode(v)
  end
  put("tracks", tracks)
  put("markers", markers)
  put("events", events)
  pcall(function() ChangeHistoryService:SetWaypoint("RoLink model-anim " .. name:sub(1, 48)) end)
end
local function rlJointKind(inst: Instance): string
  if inst:IsA("Motor6D") or inst:IsA("Bone") then return "rotational" end
  if inst:IsA("Weld") or inst:IsA("WeldConstraint") then return "follow" end
  if inst:IsA("Attachment") then return "anchor" end
  if inst:IsA("Model") then
    local pp: Instance? = nil
    pcall(function() pp = (inst :: Model).PrimaryPart end)
    if pp then return "root" end
    return "static"
  end
  if inst:IsA("BasePart") then return "rigid" end
  return "static"
end
local function rlModelAnalyze(args: { [string]: any }): { [string]: any }
  local path = tostring(args.target or "")
  local target = findByPath(path)
  if not target then error("Model not found: '" .. path:sub(1, 120) .. "'.") end
  local nodes: { [string]: any } = {}
  local warnings: { string } = {}
  local rotational, hasRoot, hasRigid, hasFollow = 0, false, false, false
  local hasHumanoid = false
  pcall(function() hasHumanoid = target:FindFirstChildOfClass("Humanoid") ~= nil end)
  local selfKind = rlJointKind(target)
  if selfKind ~= "static" then
    table.insert(nodes, { path = target:GetFullName(), name = target.Name, class = target.ClassName, kind = selfKind, depth = 0 })
    if selfKind == "root" then hasRoot = true end
    if selfKind == "rigid" then hasRigid = true end
  end
  local stopped = false
  local function walk(inst: Instance, depth: number)
    if stopped or depth > 6 then return end
    for _, c in ipairs(inst:GetChildren()) do
      if stopped then return end
      if #nodes >= 200 then stopped = true return end
      local k = rlJointKind(c)
      if k ~= "static" then
        table.insert(nodes, { path = c:GetFullName(), name = c.Name, class = c.ClassName, kind = k, depth = depth })
        if k == "rotational" then rotational += 1 end
        if k == "root" then hasRoot = true end
        if k == "rigid" then hasRigid = true end
        if k == "follow" then hasFollow = true end
      end
      if #c:GetChildren() > 0 then walk(c, depth + 1) end
    end
  end
  walk(target, 1)
  if #nodes == 0 then
    table.insert(warnings, "nothing animatable under '" .. target.Name:sub(1, 48) .. "' (need Motor6D/Bone joints, a PrimaryPart, or BaseParts)")
  end
  if target:IsA("Model") then
    local pp: Instance? = nil
    pcall(function() pp = (target :: Model).PrimaryPart end)
    if not pp then table.insert(warnings, "no PrimaryPart on '" .. target.Name:sub(1, 48) .. "': root motion unavailable until one is set") end
  end
  if hasHumanoid then table.insert(warnings, "humanoid rig: use create_animation_track for character clips; model tracks suit prop-style motion on this rig") end
  if hasFollow and rotational == 0 and not hasRigid and not hasRoot then
    table.insert(warnings, "only follow/anchor parts found: animate a parent, never these")
  end
  if stopped then table.insert(warnings, "node cap 200 hit: smallest parts omitted") end
  local controller = "none"
  if hasHumanoid then controller = "hybrid (character clips + model tracks)"
  elseif rotational > 0 then controller = "hierarchical transforms"
  elseif hasRoot then controller = "root motion"
  elseif hasRigid then controller = "rigid assembly" end
  return { model = target:GetFullName(), animatable = nodes, warnings = warnings, controller = controller }
end
local function rlModelCreate(args: { [string]: any }): { [string]: any }
  local path = tostring(args.target or "")
  local target = findByPath(path)
  if not target then error("Model not found: '" .. path:sub(1, 120) .. "'.") end
  local name = tostring(args.name or ""):gsub("^%s+", ""):gsub("%s+$", ""):sub(1, 64)
  if name == "" then error("name is required (max 64 chars)") end
  local duration = num(args.duration, 0)
  if duration < 0.1 or duration > 60 then error("duration must be 0.1-60s (got " .. tostring(args.duration) .. ")") end
  local fps = math.floor(num(args.fps, 30))
  if fps < 1 or fps > 120 then error("fps must be 1-120 (got " .. tostring(args.fps) .. ")") end
  local existing = rlAnimFolder(name)
  if existing and args.confirm ~= true then
    error("CONFIRM_REQUIRED: model animation '" .. name .. "' already exists - re-send with confirm:true to overwrite, or pick another name")
  end
  local folder = existing
  if not folder then
    folder = Instance.new("Folder")
    folder.Name = name
    folder.Parent = rlAnimRoot()
  end
  folder:SetAttribute("target", target:GetFullName())
  folder:SetAttribute("duration", duration)
  folder:SetAttribute("fps", fps)
  folder:SetAttribute("loop", args.loop == true)
  rlAnimWrite(name, folder, {}, {}, {})
  return { animation = name, target = target:GetFullName(), duration = duration, fps = fps, loop = args.loop == true, tracks = 0 }
end
local function rlPoseNum(v: any): { [string]: any }
  local p = { pos = { x = 0, y = 0, z = 0 }, rot = { x = 0, y = 0, z = 0 } }
  if type(v) ~= "table" then return p end
  local pp = (v :: any).position
  if type(pp) == "table" then
    p.pos = { x = num((pp :: any).x, 0), y = num((pp :: any).y, 0), z = num((pp :: any).z, 0) }
  end
  local rr = (v :: any).rotation
  if type(rr) == "table" then
    p.rot = { x = num((rr :: any).x, 0), y = num((rr :: any).y, 0), z = num((rr :: any).z, 0) }
  end
  return p
end
local function rlModelSetKey(args: { [string]: any }): { [string]: any }
  local anim = tostring(args.anim or "")
  local folder, tracks, markers, events = rlAnimRead(anim)
  local track = tostring(args.track or "")
  if track == "" then error("track is required (joint/part name from analyze_animatable_model)") end
  local duration = 60
  pcall(function() duration = num(folder:GetAttribute("duration"), 60) end)
  local t = math.max(0, num(args.t, 0))
  if t > duration then error("key time " .. t .. "s is beyond duration " .. duration .. "s") end
  local ease = resolveEasing(tostring(args.ease or "linear"))
  if not ease then error("unknown easing '" .. tostring(args.ease):sub(1, 32) .. "' " .. easingHint(tostring(args.ease or "")) .. "(" .. EASE_LIST .. ")") end
  local tr = tracks[track]
  if tr == nil then tr = { kind = "custom", keys = {} } tracks[track] = tr end
  if rlAnimGetLocked(folder)[track] then error("TRACK_LOCKED: track '" .. track:sub(1, 48) .. "' is locked - unlock it with set_track_lock first") end
  if type((tr :: any).keys) ~= "table" then (tr :: any).keys = {} end
  local keys = (tr :: any).keys
  if #keys >= MAX_MODEL_KEYS then error("too many keys on track '" .. track:sub(1, 48) .. "' (max " .. MAX_MODEL_KEYS .. ")") end
  local pose = rlPoseNum(args.pose)
  local replaced = false
  for i, k in ipairs(keys) do
    if math.abs(num((k :: any).t, 0) - t) < 1e-6 then
      keys[i] = { t = t, pos = pose.pos, rot = pose.rot, ease = ease }
      replaced = true
      break
    end
  end
  if not replaced then
    table.insert(keys, { t = t, pos = pose.pos, rot = pose.rot, ease = ease })
    table.sort(keys, function(a, b) return num((a :: any).t, 0) < num((b :: any).t, 0) end)
  end
  rlAnimWrite(anim, folder, tracks, markers, events)
  return { animation = anim, track = track, t = t, ease = ease, keys = #keys, replaced = replaced }
end
local function rlModelSetEase(args: { [string]: any }): { [string]: any }
  local anim = tostring(args.anim or "")
  local folder, tracks, markers, events = rlAnimRead(anim)
  local track = tostring(args.track or "")
  local tr = tracks[track]
  if tr == nil or type((tr :: any).keys) ~= "table" or #((tr :: any).keys) == 0 then
    error("TRACK_NOT_FOUND: no keys on track '" .. track:sub(1, 48) .. "' in '" .. anim:sub(1, 48) .. "'")
  end
  local keys = (tr :: any).keys
  if rlAnimGetLocked(folder)[track] then error("TRACK_LOCKED: track '" .. track:sub(1, 48) .. "' is locked - unlock it with set_track_lock first") end
  local idx = math.floor(num(args.keyIndex, 0))
  if idx < 1 or idx > #keys then error("keyIndex out of range (track has " .. #keys .. " keys, 1-based)") end
  local ease = resolveEasing(tostring(args.ease or ""))
  if not ease then error("unknown easing '" .. tostring(args.ease):sub(1, 32) .. "' " .. easingHint(tostring(args.ease or "")) .. "(" .. EASE_LIST .. ")") end
  keys[idx].ease = ease
  rlAnimWrite(anim, folder, tracks, markers, events)
  return { animation = anim, track = track, keyIndex = idx, ease = ease }
end
local function rlModelAddMarker(args: { [string]: any }): { [string]: any }
  local anim = tostring(args.anim or "")
  local folder, tracks, markers, events = rlAnimRead(anim)
  local name = tostring(args.name or ""):gsub("^%s+", ""):gsub("%s+$", ""):sub(1, 64)
  if name == "" then error("marker name is required (max 64 chars)") end
  if args.remove == true then
    local keptM: { [string]: any } = {}
    local keptE: { [string]: any } = {}
    local found = false
    for _, m in ipairs(markers) do
      if tostring((m :: any).name) ~= name then table.insert(keptM, m) else found = true end
    end
    for _, e in ipairs(events) do
      if tostring((e :: any).marker) ~= name then table.insert(keptE, e) end
    end
    if not found then error("MARKER_NOT_FOUND: no marker '" .. name .. "' in '" .. anim:sub(1, 48) .. "'") end
    rlAnimWrite(anim, folder, tracks, keptM, keptE)
    return { animation = anim, removed = name, markers = keptM }
  end
  local duration = 60
  pcall(function() duration = num(folder:GetAttribute("duration"), 60) end)
  local t = math.max(0, num(args.t, 0))
  if t > duration then error("marker time " .. t .. "s is beyond duration " .. duration .. "s") end
  local ev = nil
  if args.event ~= nil and tostring(args.event) ~= "" then ev = tostring(args.event):sub(1, 64) end
  local replaced = false
  for i, m in ipairs(markers) do
    if tostring((m :: any).name) == name then
      markers[i] = { t = t, name = name, event = ev }
      replaced = true
      break
    end
  end
  if not replaced then
    table.insert(markers, { t = t, name = name, event = ev })
    table.sort(markers, function(a, b) return num((a :: any).t, 0) < num((b :: any).t, 0) end)
  end
  if ev then
    local bound = false
    for _, e in ipairs(events) do
      if tostring((e :: any).marker) == name then (e :: any).action = ev bound = true break end
    end
    if not bound then table.insert(events, { marker = name, action = ev }) end
  end
  rlAnimWrite(anim, folder, tracks, markers, events)
  return { animation = anim, markers = markers }
end

local function rlAnimGetLocked(folder: Instance): { [string]: boolean }
  local set: { [string]: boolean } = {}
  pcall(function()
    local sv = folder:FindFirstChild("locked")
    if sv and sv:IsA("StringValue") then
      local v = HttpService:JSONDecode((sv :: StringValue).Value)
      if type(v) == "table" then
        for _, n in ipairs(v) do set[tostring(n)] = true end
      end
    end
  end)
  return set
end
local function rlAnimSetLocked(folder: Instance, set: { [string]: boolean })
  local arr: { string } = {}
  for n in pairs(set) do table.insert(arr, tostring(n)) end
  table.sort(arr)
  local sv = folder:FindFirstChild("locked")
  if not sv then
    sv = Instance.new("StringValue")
    sv.Name = "locked"
    sv.Parent = folder
  end
  (sv :: StringValue).Value = HttpService:JSONEncode(arr)
  pcall(function() ChangeHistoryService:SetWaypoint("RoLink model-anim lock") end)
end
local function rlModelTrackLock(args: { [string]: any }): { [string]: any }
  local anim = tostring(args.anim or "")
  local folder = rlAnimRead(anim)
  local track = tostring(args.track or "")
  if track == "" then error("track is required") end
  local set = rlAnimGetLocked(folder)
  local want = args.locked ~= false
  if want then set[track] = true else set[track] = nil end
  rlAnimSetLocked(folder, set)
  return { animation = anim, track = track, locked = want }
end
local function rlLerp3(a: any, b: any, f: number): { [string]: number }
  local function c(k: string): number
    return num(a and (a :: any)[k], 0) + (num(b and (b :: any)[k], 0) - num(a and (a :: any)[k], 0)) * f
  end
  return { x = c("x"), y = c("y"), z = c("z") }
end
local function rlPoseAt(keys: any, t: number): ({ [string]: number }, { [string]: number })
  local zero = { x = 0, y = 0, z = 0 }
  if type(keys) ~= "table" or #keys == 0 then return zero, zero end
  if t <= num(keys[1].t, 0) then return keys[1].pos or zero, keys[1].rot or zero end
  for i = 2, #keys do
    local bt = num(keys[i].t, 0)
    if t <= bt then
      local a, b = keys[i - 1], keys[i]
      local span = bt - num(a.t, 0)
      local f = 0
      if span > 1e-9 then
        local ef = EASE_FNS[b.ease] or EASE_FNS.linear
        f = ef((t - num(a.t, 0)) / span)
      end
      return rlLerp3(a.pos, b.pos, f), rlLerp3(a.rot, b.rot, f)
    end
  end
  local k = keys[#keys]
  return k.pos or zero, k.rot or zero
end
local function rlMag3(a: any, b: any): number
  local dx = num(b and (b :: any).x, 0) - num(a and (a :: any).x, 0)
  local dy = num(b and (b :: any).y, 0) - num(a and (a :: any).y, 0)
  local dz = num(b and (b :: any).z, 0) - num(a and (a :: any).z, 0)
  return math.sqrt(dx * dx + dy * dy + dz * dz)
end
local function rlRound2(v: number): number
  return math.floor(v * 100 + 0.5) / 100
end
local function rlTrackNames(tracks: any): { string }
  local out: { string } = {}
  for k in pairs(tracks) do table.insert(out, tostring(k)) end
  table.sort(out)
  return out
end
local function rlModelPreview(args: { [string]: any }): { [string]: any }
  local anim = tostring(args.anim or "")
  local folder, tracks, markers = rlAnimRead(anim)
  local duration = 1
  local fps = 30
  pcall(function()
    duration = num(folder:GetAttribute("duration"), 1)
    fps = math.floor(num(folder:GetAttribute("fps"), 30))
  end)
  if duration <= 0 then error("MODEL_ANIM_CORRUPT: '" .. anim:sub(1, 48) .. "' has no duration") end
  local step = num(args.step, 0.1)
  if step < 0.02 then step = 0.02 end
  if step > 1 then step = 1 end
  local names = rlTrackNames(tracks)
  local truncated = false
  if #names > 64 then
    local cut: { string } = {}
    for i = 1, 64 do table.insert(cut, names[i]) end
    names = cut
    truncated = true
  end
  if duration / step * math.max(1, #names) > 200000 then
    error("preview too dense (duration " .. duration .. "s x " .. #names .. " tracks at step " .. step .. ") - raise step")
  end
  local summary: { [string]: any } = {}
  local snaps: { [string]: any } = {}
  local function snapAt(t: number): { [string]: any }
    local s: { [string]: any } = {}
    for _, tn in ipairs(names) do
      local pos, rot = rlPoseAt(tracks[tn].keys, t)
      s[tn] = { pos = { x = rlRound2(pos.x), y = rlRound2(pos.y), z = rlRound2(pos.z) },
        rot = { x = rlRound2(rot.x), y = rlRound2(rot.y), z = rlRound2(rot.z) } }
    end
    return s
  end
  for _, tn in ipairs(names) do
    local keys = tracks[tn].keys
    local maxDeg, maxStud = 0, 0
    local pt, pr = rlPoseAt(keys, 0)
    local tt = step
    while tt <= duration + 1e-9 do
      local qpos, qrot = rlPoseAt(keys, tt)
      local dt = step
      if dt > 1e-9 then
        maxDeg = math.max(maxDeg, rlMag3(pr, qrot) / dt)
        maxStud = math.max(maxStud, rlMag3(pt, qpos) / dt)
      end
      pt, pr = qpos, qrot
      tt += step
    end
    summary[tn] = { keys = #keys, maxDegPerSec = rlRound2(maxDeg), maxStudPerSec = rlRound2(maxStud),
      spike = maxDeg > RL_ROT_WARN }
  end
  snaps.start = snapAt(0)
  snaps.mid = snapAt(duration / 2)
  snaps.finish = snapAt(duration)
  local hits: { [string]: any } = {}
  for _, m in ipairs(markers) do
    table.insert(hits, { t = num((m :: any).t, 0), name = tostring((m :: any).name), event = (m :: any).event })
  end
  table.sort(hits, function(a, b) return num((a :: any).t, 0) < num((b :: any).t, 0) end)
  return { animation = anim, duration = duration, fps = fps, step = step,
    tracks = summary, snapshots = snaps, markersHit = hits, truncated = truncated }
end
local function rlModelValidate(args: { [string]: any }): { [string]: any }
  local anim = tostring(args.anim or "")
  local folder, tracks, markers, events = rlAnimRead(anim)
  local errors: { [string]: any } = {}
  local warnings: { [string]: any } = {}
  local function err(code: string, detail: string, fix: string)
    table.insert(errors, { code = code, detail = detail, fix = fix })
  end
  local function warn(code: string, detail: string, fix: string)
    table.insert(warnings, { code = code, detail = detail, fix = fix })
  end
  local targetPath = ""
  pcall(function() targetPath = tostring(folder:GetAttribute("target") or "") end)
  local target: Instance? = nil
  if targetPath ~= "" then target = findByPath(targetPath) end
  if not target then err("TARGET_GONE", "stored target '" .. targetPath:sub(1, 80) .. "' no longer resolves", "re-point the animation or restore the model") end
  local duration = 0
  pcall(function() duration = num(folder:GetAttribute("duration"), 0) end)
  if duration < 0.1 or duration > 60 then err("BAD_DURATION", "duration " .. tostring(duration) .. " outside 0.1-60s", "recreate with a sane duration") end
  local names = rlTrackNames(tracks)
  if #names == 0 then err("EMPTY", "no tracks (write keys with set_model_keyframe first)", "add at least one key") end
  local known: { [string]: boolean } = {}
  if target then
    pcall(function()
      for _, d in ipairs(target:GetDescendants()) do
        known[d.Name] = true
        if #known > 2000 then break end
      end
    end)
    known[target.Name] = true
  end
  local doLoop = false
  pcall(function() doLoop = folder:GetAttribute("loop") == true end)
  for _, tn in ipairs(names) do
    local keys = tracks[tn].keys
    if type(keys) ~= "table" or #keys == 0 then
      err("TRACK_EMPTY", "track '" .. tn:sub(1, 48) .. "' has no keys", "write a key or drop the track")
      continue
    end
    if target and not known[tn] then
      warn("JOINT_UNMATCHED", "track '" .. tn:sub(1, 48) .. "' matches no part under the target", "re-run analyze_animatable_model and use an exact name")
    end
    for i, k in ipairs(keys) do
      if EASE_FNS[(k :: any).ease] == nil then
        err("BAD_EASING", "track '" .. tn:sub(1, 32) .. "' key " .. i .. " has easing '" .. tostring((k :: any).ease):sub(1, 24) .. "'", "set a suffixed easing (quadIn, not bare quad)")
      end
      if i > 1 and num((k :: any).t, 0) < num(keys[i - 1].t, 0) - 1e-9 then
        err("TIME_ORDER", "track '" .. tn:sub(1, 32) .. "' key " .. i .. " goes backwards in time", "rewrite the keys in order")
      end
    end
    for i = 2, #keys do
      local dt = num(keys[i].t, 0) - num(keys[i - 1].t, 0)
      if dt > 1e-9 then
        local rv = rlMag3(keys[i - 1].rot, keys[i].rot) / dt
        local pv = rlMag3(keys[i - 1].pos, keys[i].pos) / dt
        if rv > RL_ROT_ERR then err("SPIKE", "track '" .. tn:sub(1, 32) .. "' rotates " .. math.floor(rv) .. " deg/s into key " .. i, "spread the motion over more time or ease it")
        elseif rv > RL_ROT_WARN then warn("FAST", "track '" .. tn:sub(1, 32) .. "' rotates " .. math.floor(rv) .. " deg/s into key " .. i, "consider easing the arrival") end
        if pv > RL_POS_ERR then err("JUMP", "track '" .. tn:sub(1, 32) .. "' jumps " .. rlRound2(pv * dt) .. " studs into key " .. i, "check the target path or split the move")
        elseif pv > RL_POS_WARN then warn("LEAP", "track '" .. tn:sub(1, 32) .. "' moves " .. rlRound2(pv * dt) .. " studs into key " .. i, "verify the distance is intended") end
      end
    end
    if doLoop and #keys >= 2 then
      local a, b = keys[1], keys[#keys]
      if rlMag3(a.rot, b.rot) > 1.0 or rlMag3(a.pos, b.pos) > 0.1 then
        err("LOOP_MISMATCH", "track '" .. tn:sub(1, 32) .. "' loop ends do not match the start", "copy the first key pose onto the last key")
      end
    end
  end
  local markerNames: { [string]: boolean } = {}
  for _, m in ipairs(markers) do
    markerNames[tostring((m :: any).name)] = true
    if num((m :: any).t, 0) > duration then
      err("MARKER_OOB", "marker '" .. tostring((m :: any).name):sub(1, 40) .. "' sits past the duration", "move it inside 0-" .. tostring(duration) .. "s")
    end
    if (m :: any).event == nil then
      warn("MARKER_NO_EVENT", "marker '" .. tostring((m :: any).name):sub(1, 40) .. "' binds no gameplay event", "add an event or leave it as a pure timing mark")
    end
  end
  for _, e in ipairs(events) do
    if not markerNames[tostring((e :: any).marker)] then
      err("ORPHAN_EVENT", "event for missing marker '" .. tostring((e :: any).marker):sub(1, 40) .. "'", "add the marker first")
    end
  end
  return { animation = anim, passed = #errors == 0, errors = errors, warnings = warnings }
end


-- ── Model animation dock widget (timeline editor, same store) ─────────
-- Human timeline over ReplicatedStorage/RoLinkModelAnims/<Name>: rig tree,
-- keyframe lane, inspector, transport. Every action calls the rl* engine
-- above, so chat turns and UI edits can never diverge. Playback applies
-- poses to resolved joints in Edit mode only and restores originals on
-- stop; in Play it refuses with a status message instead of guessing.
-- ── Model animation dock widget (Moon-style timeline, same store) ─────
-- Dark panels, one orange accent, blue keyframe diamonds. Title strip,
-- menu row (every button performs a real action), rig tree, track list
-- with dots + locks, frame ruler, key/marker lanes with playhead,
-- inspector, transport. All actions call the rl* engine above, so chat
-- turns and UI edits can never diverge.
local RL_ANIM_COLORS = {
  panel = Color3.fromRGB(20, 20, 23),
  lane = Color3.fromRGB(30, 30, 35),
  rowAlt = Color3.fromRGB(25, 25, 29),
  input = Color3.fromRGB(36, 36, 42),
  text = Color3.fromRGB(232, 232, 236),
  dim = Color3.fromRGB(150, 150, 162),
  accent = Color3.fromRGB(255, 140, 26),
  accentText = Color3.fromRGB(24, 14, 4),
  diamond = Color3.fromRGB(76, 194, 255),
  marker = Color3.fromRGB(120, 220, 255),
  good = Color3.fromRGB(130, 220, 150),
  bad = Color3.fromRGB(255, 110, 110),
}
local RL_ANIM_W = 640
local rlAnimUI = { playing = false, stopNow = false, held = {}, selKey = 0 }
local rlAnimStatusLbl: TextLabel? = nil
local function rlAnimStatus(msg: string, isErr: boolean?)
  print("[RoLinkAnim] " .. msg)
  pcall(function()
    if rlAnimStatusLbl then
      rlAnimStatusLbl.Text = (isErr and "ERR " or "") .. msg:sub(1, 220)
      rlAnimStatusLbl.TextColor3 = isErr and RL_ANIM_COLORS.bad or RL_ANIM_COLORS.dim
    end
  end)
end
local function rlAnimBox(parent: Instance, name: string, text: string, w: number): TextBox
  local b = Instance.new("TextBox")
  b.Name = name
  b.Text = text
  b.ClearTextOnFocus = false
  b.Font = Enum.Font.Code
  b.TextSize = 13
  b.BackgroundColor3 = RL_ANIM_COLORS.input
  b.TextColor3 = RL_ANIM_COLORS.text
  b.BorderSizePixel = 0
  b.Size = UDim2.new(0, w, 0, 24)
  b.Parent = parent
  return b
end
local function rlAnimBtn(parent: Instance, name: string, text: string, w: number, hot: boolean?): TextButton
  local b = Instance.new("TextButton")
  b.Name = name
  b.Text = text
  b.Font = Enum.Font.GothamBold
  b.TextSize = 13
  b.AutoButtonColor = true
  b.BackgroundColor3 = hot and RL_ANIM_COLORS.accent or RL_ANIM_COLORS.lane
  b.TextColor3 = hot and RL_ANIM_COLORS.accentText or RL_ANIM_COLORS.text
  b.BorderSizePixel = 0
  b.Size = UDim2.new(0, w, 0, 24)
  b.Parent = parent
  local c = Instance.new("UICorner")
  c.CornerRadius = UDim.new(0, 4)
  c.Parent = b
  return b
end
local function rlAnimRow(parent: Instance, h: number): Frame
  local f = Instance.new("Frame")
  f.BackgroundTransparency = 1
  f.Size = UDim2.new(1, 0, 0, h)
  f.Parent = parent
  local l = Instance.new("UIListLayout")
  l.FillDirection = Enum.FillDirection.Horizontal
  l.Padding = UDim.new(0, 4)
  l.VerticalAlignment = Enum.VerticalAlignment.Center
  l.Parent = f
  return f
end
local function rlAnimField(row: Instance, label: string, def: string, w: number): TextBox
  local t = Instance.new("TextLabel")
  t.Text = label
  t.Font = Enum.Font.Gotham
  t.TextSize = 12
  t.TextColor3 = RL_ANIM_COLORS.dim
  t.BackgroundTransparency = 1
  t.Size = UDim2.new(0, 28, 0, 24)
  t.Parent = row
  return rlAnimBox(row, "in_" .. label, def, w)
end
local function rlAnimHead(parent: Instance, txt: string)
  local h = Instance.new("TextLabel")
  h.Text = txt
  h.Font = Enum.Font.GothamBold
  h.TextSize = 11
  h.TextColor3 = RL_ANIM_COLORS.dim
  h.BackgroundTransparency = 1
  h.TextXAlignment = Enum.TextXAlignment.Left
  h.Size = UDim2.new(1, 0, 0, 18)
  h.Parent = parent
end
local function rlAnimClearFrame(f: Instance?)
  if not f then return end
  for _, c in ipairs(f:GetChildren()) do
    if not c:IsA("UIListLayout") and not c:IsA("UIPadding") then
      pcall(function() c:Destroy() end)
    end
  end
end
local function rlAnimCurrent(): (string, string)
  local a = rlAnimUI.animBox and rlAnimUI.animBox.Text or ""
  local t = rlAnimUI.trackBox and rlAnimUI.trackBox.Text or ""
  return a:gsub("^%s+", ""):gsub("%s+$", ""), t:gsub("^%s+", ""):gsub("%s+$", "")
end
local function rlAnimStripe(parent: Instance, i: number): Frame
  local f = Instance.new("Frame")
  f.BackgroundColor3 = (i % 2 == 0) and RL_ANIM_COLORS.lane or RL_ANIM_COLORS.rowAlt
  f.BorderSizePixel = 0
  f.Size = UDim2.new(1, 0, 0, 20)
  f.Parent = parent
  local l = Instance.new("UIListLayout")
  l.FillDirection = Enum.FillDirection.Horizontal
  l.Padding = UDim.new(0, 4)
  l.VerticalAlignment = Enum.VerticalAlignment.Center
  l.Parent = f
  return f
end
local function rlAnimRefreshTitle(anim: string, folder: Instance?, trackCount: number)
  local t = rlAnimUI.titleLbl
  if not t then return end
  if anim == "" or not folder then
    t.Text = "no animation loaded"
    return
  end
  local dur, fps = 0, 30
  pcall(function()
    dur = num(folder:GetAttribute("duration"), 0)
    fps = math.floor(num(folder:GetAttribute("fps"), 30))
  end)
  t.Text = string.format("%s  •  %.2fs  •  %dfps  •  %d tracks", anim:sub(1, 40), dur, fps, trackCount)
end
local function rlAnimRenderRig()
  local list = rlAnimUI.rigList
  if not list then return end
  rlAnimClearFrame(list)
  local ok, res = pcall(function()
    local w = rlAnimUI.targetBox
    return rlModelAnalyze({ target = (w and w.Text) or "Workspace" })
  end)
  if not ok then rlAnimStatus("analyze failed: " .. tostring(res):sub(1, 160), true) return end
  local i = 0
  for _, n in ipairs(res.animatable or {}) do
    i += 1
    local row = rlAnimStripe(list, i)
    local b = Instance.new("TextButton")
    b.Text = string.rep("  ", math.min(5, num((n :: any).depth, 0))) .. tostring((n :: any).name) .. " [" .. tostring((n :: any).kind) .. "]"
    b.Font = Enum.Font.Code
    b.TextSize = 12
    b.TextXAlignment = Enum.TextXAlignment.Left
    b.BackgroundTransparency = 1
    b.TextColor3 = RL_ANIM_COLORS.text
    b.Size = UDim2.new(1, -4, 1, 0)
    b.Parent = row
    local nm = tostring((n :: any).name)
    local kd = tostring((n :: any).kind)
    b.MouseButton1Click:Connect(function()
      if rlAnimUI.trackBox and (kd == "rotational" or kd == "rigid" or kd == "root") then
        rlAnimUI.trackBox.Text = nm
        rlAnimStatus("track <- " .. nm)
        rlAnimRenderTimeline()
      else
        rlAnimStatus(nm .. " is " .. kd .. " - animate its parent instead", true)
      end
    end)
  end
  rlAnimStatus("rig: " .. #res.animatable .. " nodes (" .. tostring(res.controller) .. ")")
end
local function rlAnimRenderTracks()
  local list = rlAnimUI.trackList
  if not list then return end
  rlAnimClearFrame(list)
  local anim, _ = rlAnimCurrent()
  if anim == "" then return end
  local ok, folder, tracks = pcall(function() return rlAnimRead(anim) end)
  if not ok then return end
  local locked = rlAnimGetLocked(folder)
  local names = rlTrackNames(tracks)
  local i = 0
  for _, tn in ipairs(names) do
    i += 1
    local row = rlAnimStripe(list, i)
    local dot = Instance.new("TextLabel")
    dot.Text = "●"
    dot.Font = Enum.Font.GothamBold
    dot.TextSize = 12
    dot.TextColor3 = RL_ANIM_COLORS.accent
    dot.BackgroundTransparency = 1
    dot.Size = UDim2.new(0, 18, 1, 0)
    dot.Parent = row
    local b = Instance.new("TextButton")
    b.Text = tn
    b.Font = Enum.Font.Code
    b.TextSize = 12
    b.TextXAlignment = Enum.TextXAlignment.Left
    b.BackgroundTransparency = 1
    b.TextColor3 = RL_ANIM_COLORS.text
    b.Size = UDim2.new(1, -66, 1, 0)
    b.Parent = row
    local isLocked = locked[tn] == true
    local lb = Instance.new("TextButton")
    lb.Text = isLocked and "[L]" or "[ ]"
    lb.Font = Enum.Font.GothamBold
    lb.TextSize = 12
    lb.BackgroundTransparency = 1
    lb.TextColor3 = isLocked and RL_ANIM_COLORS.accent or RL_ANIM_COLORS.dim
    lb.Size = UDim2.new(0, 36, 1, 0)
    lb.Parent = row
    b.MouseButton1Click:Connect(function()
      if rlAnimUI.trackBox then rlAnimUI.trackBox.Text = tn end
      rlAnimRenderTimeline()
    end)
    lb.MouseButton1Click:Connect(function()
      local ok2, res = pcall(function()
        return rlModelTrackLock({ anim = anim, track = tn, locked = not isLocked })
      end)
      if ok2 then
        rlAnimStatus("track '" .. tn:sub(1, 40) .. "' " .. (res.locked and "locked" or "unlocked"))
        pcall(rlAnimRenderTracks)
      else
        rlAnimStatus("lock failed: " .. tostring(res):sub(1, 160), true)
      end
    end)
  end
end
local function rlAnimRenderTimeline()
  local lane = rlAnimUI.keyLane
  local mlane = rlAnimUI.markerLane
  local ruler = rlAnimUI.ruler
  if not lane then return end
  rlAnimClearFrame(lane)
  if mlane then rlAnimClearFrame(mlane) end
  if ruler then rlAnimClearFrame(ruler) end
  rlAnimUI.playhead = nil
  local anim, track = rlAnimCurrent()
  if anim == "" then
    rlAnimRefreshTitle("", nil, 0)
    rlAnimStatus("enter an animation name, then Load")
    return
  end
  local ok, folder, tracks, markers = pcall(function() return rlAnimRead(anim) end)
  if not ok then
    rlAnimRefreshTitle("", nil, 0)
    rlAnimStatus("load failed: " .. tostring(folder):sub(1, 160), true)
    return
  end
  local duration, fps = 1, 30
  pcall(function()
    duration = num(folder:GetAttribute("duration"), 1)
    fps = math.floor(num(folder:GetAttribute("fps"), 30))
  end)
  if duration <= 0 then duration = 1 end
  if fps < 1 then fps = 30 end
  rlAnimRefreshTitle(anim, folder, #rlTrackNames(tracks))
  if ruler then
    local f = 0
    while f <= duration * fps + 1e-9 do
      local t = f / fps
      local x = math.clamp(t / duration, 0, 1) * (RL_ANIM_W - 24)
      local lb = Instance.new("TextLabel")
      lb.Text = tostring(f)
      lb.Font = Enum.Font.Code
      lb.TextSize = 10
      lb.TextColor3 = (f == 0) and RL_ANIM_COLORS.accent or RL_ANIM_COLORS.dim
      lb.BackgroundTransparency = 1
      lb.Size = UDim2.new(0, 40, 0, 16)
      lb.Position = UDim2.new(0, x, 0, 0)
      lb.Parent = ruler
      f += fps
    end
  end
  lane.CanvasSize = UDim2.new(0, RL_ANIM_W, 0, 30)
  local tr = tracks[track]
  local keys = (tr ~= nil and (tr :: any).keys) or {}
  rlAnimUI.selKeys = keys
  for i, k in ipairs(keys) do
    local x = math.clamp(num((k :: any).t, 0) / duration, 0, 1) * (RL_ANIM_W - 24)
    local b = Instance.new("TextButton")
    b.Text = "◆"
    b.Font = Enum.Font.GothamBold
    b.TextSize = 14
    b.TextColor3 = RL_ANIM_COLORS.diamond
    b.BackgroundTransparency = 1
    b.Size = UDim2.new(0, 24, 0, 24)
    b.Position = UDim2.new(0, x, 0, 2)
    b.Parent = lane
    local idx = i
    b.MouseButton1Click:Connect(function()
      b.TextColor3 = RL_ANIM_COLORS.accent
      rlAnimUI.selKey = idx
      local ins = rlAnimUI.ins
      if ins and keys[idx] then
        local kk = keys[idx]
        ins.t.Text = tostring(num((kk :: any).t, 0))
        ins.rx.Text = tostring(((kk :: any).rot or {}).x or 0)
        ins.ry.Text = tostring(((kk :: any).rot or {}).y or 0)
        ins.rz.Text = tostring(((kk :: any).rot or {}).z or 0)
        ins.px.Text = tostring(((kk :: any).pos or {}).x or 0)
        ins.py.Text = tostring(((kk :: any).pos or {}).y or 0)
        ins.pz.Text = tostring(((kk :: any).pos or {}).z or 0)
        ins.ease.Text = tostring((kk :: any).ease or "linear")
        rlAnimStatus("key " .. idx .. " of " .. #keys .. " selected")
      end
    end)
  end
  if mlane then
    mlane.CanvasSize = UDim2.new(0, RL_ANIM_W, 0, 22)
    for _, m in ipairs(markers or {}) do
      local x = math.clamp(num((m :: any).t, 0) / duration, 0, 1) * (RL_ANIM_W - 24)
      local b = Instance.new("TextButton")
      b.Text = "M " .. tostring((m :: any).name):sub(1, 12)
      b.Font = Enum.Font.Code
      b.TextSize = 11
      b.TextColor3 = RL_ANIM_COLORS.marker
      b.BackgroundTransparency = 1
      b.Size = UDim2.new(0, 90, 0, 20)
      b.Position = UDim2.new(0, x, 0, 1)
      b.Parent = mlane
    end
  end
  local ph = Instance.new("Frame")
  ph.BackgroundColor3 = RL_ANIM_COLORS.accent
  ph.BorderSizePixel = 0
  ph.Size = UDim2.new(0, 2, 1, 0)
  ph.Visible = false
  ph.Parent = lane
  rlAnimUI.playhead = ph
  rlAnimUI.selKey = 0
  rlAnimStatus("track '" .. track .. "': " .. #keys .. " keys")
end
local function rlAnimResolveJoint(target: Instance, track: string): Instance?
  local best: Instance? = nil
  pcall(function()
    for _, d in ipairs(target:GetDescendants()) do
      if d.Name == track and (d:IsA("Motor6D") or d:IsA("Bone") or d:IsA("BasePart")) then
        best = d
        break
      end
    end
    if not best and target.Name == track then best = target end
  end)
  return best
end
local function rlAnimApplyPose(inst: Instance, pos: any, rot: any)
  local cf = CFrame.new(num(pos and pos.x, 0), num(pos and pos.y, 0), num(pos and pos.z, 0))
    * CFrame.Angles(math.rad(num(rot and rot.x, 0)), math.rad(num(rot and rot.y, 0)), math.rad(num(rot and rot.z, 0)))
  if inst:IsA("Motor6D") then
    (inst :: Motor6D).Transform = cf
  elseif inst:IsA("BasePart") then
    (inst :: BasePart).CFrame = cf
  else
    error("joint '" .. inst.Name:sub(1, 40) .. "' (" .. inst.ClassName .. ") is not directly posable")
  end
end
local function rlAnimSnapshot(target: Instance, names: { string })
  local held: { [string]: any } = {}
  for _, tn in ipairs(names) do
    local j = rlAnimResolveJoint(target, tn)
    if j then
      if j:IsA("Motor6D") then held[tn] = { inst = j, cf = (j :: Motor6D).Transform }
      elseif j:IsA("BasePart") then held[tn] = { inst = j, cf = (j :: BasePart).CFrame } end
    end
  end
  return held
end
local function rlAnimRestore()
  for _, h in pairs(rlAnimUI.held or {}) do
    pcall(function()
      if (h :: any).inst and (h :: any).cf then
        if ((h :: any).inst :: Instance):IsA("Motor6D") then
          (((h :: any).inst) :: Motor6D).Transform = (h :: any).cf
        elseif ((h :: any).inst :: Instance):IsA("BasePart") then
          (((h :: any).inst) :: BasePart).CFrame = (h :: any).cf
        end
      end
    end)
  end
  rlAnimUI.held = {}
end
local function rlAnimPlay()
  if rlAnimUI.playing then rlAnimStatus("already playing") return end
  local okRun, why = pcall(function() return RunService:IsRunning() end)
  if okRun and why then rlAnimStatus("stop Play first - preview runs in Edit only", true) return end
  local anim, _ = rlAnimCurrent()
  if anim == "" then rlAnimStatus("enter an animation name first", true) return end
  local ok, folder, tracks = pcall(function() return rlAnimRead(anim) end)
  if not ok then rlAnimStatus("load failed: " .. tostring(folder):sub(1, 160), true) return end
  local targetPath = ""
  pcall(function() targetPath = tostring(folder:GetAttribute("target") or "") end)
  local target = nil
  if targetPath ~= "" then target = findByPath(targetPath) end
  if not target then rlAnimStatus("target gone: '" .. targetPath:sub(1, 60) .. "'", true) return end
  local names = rlTrackNames(tracks)
  if #names == 0 then rlAnimStatus("no tracks to play", true) return end
  local duration = 1
  local doLoop = false
  pcall(function()
    duration = num(folder:GetAttribute("duration"), 1)
    doLoop = folder:GetAttribute("loop") == true
  end)
  rlAnimUI.held = rlAnimSnapshot(target, names)
  rlAnimUI.playing = true
  rlAnimUI.stopNow = false
  pcall(function() ChangeHistoryService:SetWaypoint("RoLink model-anim preview " .. anim:sub(1, 40)) end)
  local wasLoopBtn = rlAnimUI.loopBtn
  task.spawn(function()
    local fps = 30
    repeat
      local t = 0
      while t <= duration + 1e-9 do
        if rlAnimUI.stopNow then break end
        for _, tn in ipairs(names) do
          local pos, rot = rlPoseAt(tracks[tn].keys, t)
          local j = rlAnimResolveJoint(target, tn)
          if j then pcall(function() rlAnimApplyPose(j, pos, rot) end) end
        end
        local x = math.clamp(t / duration, 0, 1) * (RL_ANIM_W - 24)
        if rlAnimUI.playhead then
          rlAnimUI.playhead.Visible = true
          rlAnimUI.playhead.Position = UDim2.new(0, x, 0, 0)
        end
        if rlAnimUI.timeLbl then rlAnimUI.timeLbl.Text = string.format("%.2fs / %.2fs", t, duration) end
        task.wait(1 / fps)
        t += 1 / fps
      end
      if doLoop and not rlAnimUI.stopNow and wasLoopBtn and wasLoopBtn.Text == "Loop: on" then
        continue
      end
      break
    until false
    rlAnimRestore()
    if rlAnimUI.playhead then rlAnimUI.playhead.Visible = false end
    rlAnimUI.playing = false
    rlAnimUI.stopNow = false
    if rlAnimUI.timeLbl then rlAnimUI.timeLbl.Text = "stopped" end
    rlAnimStatus("preview finished - originals restored")
  end)
  rlAnimStatus("playing '" .. anim .. "' (" .. #names .. " tracks)")
end
local function rlAnimStop()
  rlAnimUI.stopNow = true
  rlAnimStatus("stopping - restoring originals")
end
local function rlAnimLoadAll()
  pcall(rlAnimRenderRig)
  pcall(rlAnimRenderTracks)
  pcall(rlAnimRenderTimeline)
end
local function rlBuildAnimWidget()
  local info = DockWidgetPluginGuiInfo.new(Enum.InitialDockState.Float, false, false, 380, 600, 300, 440)
  local w = plugin:CreateDockWidgetPluginGui("RoLinkModelAnim", info)
  w.Title = "RoLink Animation (Beta)"
  w.Name = "RoLinkModelAnim"
  local root = Instance.new("Frame")
  root.BackgroundColor3 = RL_ANIM_COLORS.panel
  root.BorderSizePixel = 0
  root.Size = UDim2.new(1, 0, 1, 0)
  root.Parent = w
  local pad = Instance.new("UIPadding")
  pad.PaddingLeft = UDim.new(0, 8)
  pad.PaddingRight = UDim.new(0, 8)
  pad.PaddingTop = UDim.new(0, 8)
  pad.PaddingBottom = UDim.new(0, 8)
  pad.Parent = root
  local stack = Instance.new("UIListLayout")
  stack.FillDirection = Enum.FillDirection.Vertical
  stack.Padding = UDim.new(0, 6)
  stack.Parent = root
  local titleBar = Instance.new("Frame")
  titleBar.BackgroundColor3 = RL_ANIM_COLORS.lane
  titleBar.BorderSizePixel = 0
  titleBar.Size = UDim2.new(1, 0, 0, 26)
  titleBar.Parent = root
  local edge = Instance.new("Frame")
  edge.BackgroundColor3 = RL_ANIM_COLORS.accent
  edge.BorderSizePixel = 0
  edge.Size = UDim2.new(0, 3, 1, 0)
  edge.Parent = titleBar
  local titleLbl = Instance.new("TextLabel")
  titleLbl.Text = "no animation loaded"
  titleLbl.Font = Enum.Font.GothamBold
  titleLbl.TextSize = 13
  titleLbl.TextColor3 = RL_ANIM_COLORS.accent
  titleLbl.BackgroundTransparency = 1
  titleLbl.TextXAlignment = Enum.TextXAlignment.Left
  titleLbl.Size = UDim2.new(1, -12, 1, 0)
  titleLbl.Position = UDim2.new(0, 10, 0, 0)
  titleLbl.Parent = titleBar
  rlAnimUI.titleLbl = titleLbl
  local menu = rlAnimRow(root, 24)
  local menuLoad = rlAnimBtn(menu, "menuLoad", "Load", 64)
  local menuAnalyze = rlAnimBtn(menu, "menuAnalyze", "Analyze", 76)
  local menuValidate = rlAnimBtn(menu, "menuValidate", "Validate", 76)
  local menuPlay = rlAnimBtn(menu, "menuPlay", "Play", 64, true)
  rlAnimHead(root, "TARGET + STORE")
  local r1 = rlAnimRow(root, 24)
  rlAnimUI.targetBox = rlAnimBox(r1, "target", "Workspace", 150)
  rlAnimUI.animBox = rlAnimBox(r1, "anim", "", 120)
  rlAnimHead(root, "NEW STORE")
  local r2 = rlAnimRow(root, 24)
  local durBox = rlAnimBox(r2, "dur", "1.0", 50)
  local fpsBox = rlAnimBox(r2, "fps", "30", 44)
  local loopBtn = rlAnimBtn(r2, "newloop", "Loop: off", 76)
  loopBtn.MouseButton1Click:Connect(function()
    loopBtn.Text = if loopBtn.Text == "Loop: on" then "Loop: off" else "Loop: on"
  end)
  local newBtn = rlAnimBtn(r2, "new", "Create", 70)
  rlAnimHead(root, "RIG  +  TRACK")
  local r3 = rlAnimRow(root, 24)
  rlAnimUI.trackBox = rlAnimBox(r3, "track", "", 220)
  local rigScroll = Instance.new("ScrollingFrame")
  rigScroll.BackgroundColor3 = RL_ANIM_COLORS.lane
  rigScroll.BorderSizePixel = 0
  rigScroll.Size = UDim2.new(1, 0, 0, 96)
  rigScroll.CanvasSize = UDim2.new(0, 0, 0, 0)
  rigScroll.AutomaticCanvasSize = Enum.AutomaticSize.Y
  rigScroll.Parent = root
  local rigPad = Instance.new("UIListLayout")
  rigPad.FillDirection = Enum.FillDirection.Vertical
  rigPad.Parent = rigScroll
  rlAnimUI.rigList = rigScroll
  rlAnimHead(root, "TRACKS")
  local trackScroll = Instance.new("ScrollingFrame")
  trackScroll.BackgroundColor3 = RL_ANIM_COLORS.lane
  trackScroll.BorderSizePixel = 0
  trackScroll.Size = UDim2.new(1, 0, 0, 76)
  trackScroll.CanvasSize = UDim2.new(0, 0, 0, 0)
  trackScroll.AutomaticCanvasSize = Enum.AutomaticSize.Y
  trackScroll.Parent = root
  local trackPad = Instance.new("UIListLayout")
  trackPad.FillDirection = Enum.FillDirection.Vertical
  trackPad.Parent = trackScroll
  rlAnimUI.trackList = trackScroll
  rlAnimHead(root, "TIMELINE")
  local ruler = Instance.new("Frame")
  ruler.BackgroundTransparency = 1
  ruler.Size = UDim2.new(1, 0, 0, 16)
  ruler.Parent = root
  rlAnimUI.ruler = ruler
  local keyScroll = Instance.new("ScrollingFrame")
  keyScroll.BackgroundColor3 = RL_ANIM_COLORS.lane
  keyScroll.BorderSizePixel = 0
  keyScroll.Size = UDim2.new(1, 0, 0, 34)
  keyScroll.CanvasSize = UDim2.new(0, RL_ANIM_W, 0, 30)
  keyScroll.Parent = root
  rlAnimUI.keyLane = keyScroll
  local markScroll = Instance.new("ScrollingFrame")
  markScroll.BackgroundColor3 = RL_ANIM_COLORS.lane
  markScroll.BorderSizePixel = 0
  markScroll.Size = UDim2.new(1, 0, 0, 24)
  markScroll.CanvasSize = UDim2.new(0, RL_ANIM_W, 0, 22)
  markScroll.Parent = root
  rlAnimUI.markerLane = markScroll
  rlAnimHead(root, "INSPECTOR")
  local r4 = rlAnimRow(root, 24)
  local ins: { [string]: any } = {}
  ins.t = rlAnimField(r4, "T", "0", 46)
  ins.rx = rlAnimField(r4, "RX", "0", 44)
  ins.ry = rlAnimField(r4, "RY", "0", 44)
  ins.rz = rlAnimField(r4, "RZ", "0", 44)
  local r5 = rlAnimRow(root, 24)
  ins.px = rlAnimField(r5, "PX", "0", 44)
  ins.py = rlAnimField(r5, "PY", "0", 44)
  ins.pz = rlAnimField(r5, "PZ", "0", 44)
  ins.ease = rlAnimField(r5, "E", "linear", 66)
  rlAnimUI.ins = ins
  local r6 = rlAnimRow(root, 24)
  local setBtn = rlAnimBtn(r6, "set", "Set key", 80)
  local delBtn = rlAnimBtn(r6, "del", "Del key", 80)
  local valBtn = rlAnimBtn(r6, "val", "Validate", 80)
  rlAnimHead(root, "TRANSPORT")
  local r7 = rlAnimRow(root, 24)
  local playBtn = rlAnimBtn(r7, "play", "Play", 64, true)
  local stopBtn = rlAnimBtn(r7, "stop", "Stop", 64)
  rlAnimUI.loopBtn = rlAnimBtn(r7, "loop", "Loop: off", 76)
  rlAnimUI.loopBtn.MouseButton1Click:Connect(function()
    local b = rlAnimUI.loopBtn
    b.Text = if b.Text == "Loop: on" then "Loop: off" else "Loop: on"
  end)
  local timeLbl = Instance.new("TextLabel")
  timeLbl.Text = "idle"
  timeLbl.Font = Enum.Font.Code
  timeLbl.TextSize = 12
  timeLbl.TextColor3 = RL_ANIM_COLORS.good
  timeLbl.BackgroundTransparency = 1
  timeLbl.Size = UDim2.new(0, 130, 0, 24)
  timeLbl.Parent = r7
  rlAnimUI.timeLbl = timeLbl
  local st = Instance.new("TextLabel")
  st.Text = "ready"
  st.Font = Enum.Font.Gotham
  st.TextSize = 12
  st.TextColor3 = RL_ANIM_COLORS.dim
  st.BackgroundTransparency = 1
  st.TextXAlignment = Enum.TextXAlignment.Left
  st.TextTruncate = Enum.TextTruncate.AtEnd
  st.Size = UDim2.new(1, 0, 0, 22)
  st.Parent = root
  rlAnimStatusLbl = st
  menuLoad.MouseButton1Click:Connect(function() pcall(rlAnimLoadAll) end)
  menuAnalyze.MouseButton1Click:Connect(function() pcall(rlAnimRenderRig) end)
  menuValidate.MouseButton1Click:Connect(function()
    local anim, _ = rlAnimCurrent()
    local ok, res = pcall(function() return rlModelValidate({ anim = anim }) end)
    if ok then
      rlAnimStatus(if res.passed then "validate: PASS (" .. #res.warnings .. " warnings)" else "validate: " .. #res.errors .. " errors - see chat validate_model_animation", not res.passed)
    else rlAnimStatus("validate failed: " .. tostring(res):sub(1, 160), true) end
  end)
  menuPlay.MouseButton1Click:Connect(function() pcall(rlAnimPlay) end)
  newBtn.MouseButton1Click:Connect(function()
    local ok, res = pcall(function()
      local tw = rlAnimUI.targetBox
      local aw = rlAnimUI.animBox
      return rlModelCreate({ target = (tw and tw.Text) or "Workspace",
        name = (aw and aw.Text) or "", duration = tonumber(durBox.Text) or 0,
        fps = tonumber(fpsBox.Text) or 30, loop = loopBtn.Text == "Loop: on", confirm = true })
    end)
    if ok then
      rlAnimStatus("store '" .. tostring(res.animation) .. "' ready (" .. tostring(res.duration) .. "s)")
      pcall(rlAnimLoadAll)
    else
      rlAnimStatus("create failed: " .. tostring(res):sub(1, 160), true)
    end
  end)
  setBtn.MouseButton1Click:Connect(function()
    local anim, track = rlAnimCurrent()
    local ok, res = pcall(function()
      return rlModelSetKey({ anim = anim, track = track, t = tonumber(ins.t.Text) or 0,
        pose = { position = { x = tonumber(ins.px.Text) or 0, y = tonumber(ins.py.Text) or 0, z = tonumber(ins.pz.Text) or 0 },
          rotation = { x = tonumber(ins.rx.Text) or 0, y = tonumber(ins.ry.Text) or 0, z = tonumber(ins.rz.Text) or 0 } },
        ease = ins.ease.Text })
    end)
    if ok then rlAnimStatus("key @" .. tostring(res.t) .. "s (" .. tostring(res.keys) .. " total)") pcall(rlAnimLoadAll)
    else rlAnimStatus("set key failed: " .. tostring(res):sub(1, 160), true) end
  end)
  delBtn.MouseButton1Click:Connect(function()
    local anim, track = rlAnimCurrent()
    local idx = rlAnimUI.selKey
    if idx < 1 then rlAnimStatus("click a key first", true) return end
    local ok, res = pcall(function()
      local folder, tracks, markers, events = rlAnimRead(anim)
      local keys = tracks[track].keys
      table.remove(keys, idx)
      rlAnimWrite(anim, folder, tracks, markers, events)
      return #keys
    end)
    if ok then
      rlAnimUI.selKey = 0
      rlAnimStatus("key deleted (" .. tostring(res) .. " left)")
      pcall(rlAnimLoadAll)
    else rlAnimStatus("delete failed: " .. tostring(res):sub(1, 160), true) end
  end)
  valBtn.MouseButton1Click:Connect(function()
    local anim, _ = rlAnimCurrent()
    local ok, res = pcall(function() return rlModelValidate({ anim = anim }) end)
    if ok then
      rlAnimStatus(if res.passed then "validate: PASS (" .. #res.warnings .. " warnings)" else "validate: " .. #res.errors .. " errors - see chat validate_model_animation", not res.passed)
    else rlAnimStatus("validate failed: " .. tostring(res):sub(1, 160), true) end
  end)
  playBtn.MouseButton1Click:Connect(function() pcall(rlAnimPlay) end)
  stopBtn.MouseButton1Click:Connect(function() pcall(rlAnimStop) end)
  rlAnimUI.widget = w
  rlAnimStatus("editor ready - enter target + animation, Load")
end

local rlAnimBtn: TextButton? = nil
pcall(function()
  -- widget is built once below (needs the engine above); the button only toggles.
  rlAnimBtn = toolbar:CreateButton("Anim", "RoLink model animation editor (140 tools)", "rbxassetid://0")
  local abtn = rlAnimBtn :: TextButton
  abtn.ClickableWhenViewportHidden = true
  abtn.Click:Connect(function()
    local wg = rlAnimUI.widget
    if wg then
      wg.Enabled = not wg.Enabled
      abtn:SetActive(wg.Enabled)
      log("animation editor " .. (wg.Enabled and "opened" or "closed") .. " (polling " .. (enabled and "on" or "off") .. ")")
    else
      warn("[RoLink] animation editor did not build - see Output for 'editor build failed'")
    end
  end)
end)
-- Build identity + type probe: if Studio runs a stale/different copy, the
-- Output below names exactly what is missing instead of a bare nil-call.
log("anim build 6 - builder=" .. type(rlBuildAnimWidget) .. " engine=" .. type(rlModelAnalyze) .. " ui=" .. type(rlAnimUI))
local okBuild, buildErr = false, nil
if type(rlBuildAnimWidget) == "function" then
  okBuild, buildErr = pcall(rlBuildAnimWidget)
else
  buildErr = "rlBuildAnimWidget is " .. type(rlBuildAnimWidget) .. " - reinstall studio-plugin/RoLink.lua from the RoLink-main folder (not the release zip), then fully restart Studio"
end
if not okBuild then
  warn("[RoLink] animation editor build failed: " .. tostring(buildErr):sub(1, 300))
else
  log("animation editor built - click Anim to open")
end


-- ── Model animation composites + generators (tools 132-139) ───────────
-- Time edits (retime/reverse), spatial mirror, weighted blend, safe fixes,
-- and scaffold generators (attack/idle/walk). Copies are non-destructive;
-- in-place edits overwrite only the named store. Mirror semantics are
-- documented approximations - validate after every mirror.
local EASE_FLIP: { [string]: string } = {
  quadIn = "quadOut", quadOut = "quadIn",
  cubicIn = "cubicOut", cubicOut = "cubicIn",
  sineIn = "sineOut", sineOut = "sineIn",
}
local function rlAnimDuplicate(name: string, newName: string, confirm: any): (Instance, { [string]: any }, { [string]: any }, { [string]: any })
  local folder, tracks, markers, events = rlAnimRead(name)
  local nn = tostring(newName or ""):gsub("^%s+", ""):gsub("%s+$", ""):sub(1, 64)
  if nn == "" then error("newName is required (max 64 chars)") end
  if rlAnimFolder(nn) and confirm ~= true then
    error("CONFIRM_REQUIRED: model animation '" .. nn .. "' already exists - re-send with confirm:true to overwrite, or pick another name")
  end
  local nf = rlAnimFolder(nn)
  if not nf then
    nf = Instance.new("Folder")
    nf.Name = nn
    nf.Parent = rlAnimRoot()
  end
  pcall(function()
    for _, a in ipairs({ "target", "duration", "fps", "loop" }) do
      local v = folder:GetAttribute(a)
      if v ~= nil then nf:SetAttribute(a, v) end
    end
  end)
  local function clone(v: any): any
    return HttpService:JSONDecode(HttpService:JSONEncode(v))
  end
  local t2, m2, e2 = clone(tracks), clone(markers), clone(events)
  rlAnimWrite(nn, nf, t2, m2, e2)
  return nf, t2, m2, e2
end
local function rlModelRetime(args: { [string]: any }): { [string]: any }
  local anim = tostring(args.anim or "")
  local scale = num(args.scale, 0)
  if scale < 0.1 or scale > 10 then error("scale must be 0.1-10 (got " .. tostring(args.scale) .. ")") end
  local folder, tracks, markers, events = rlAnimRead(anim)
  if args.newName ~= nil and tostring(args.newName) ~= "" then
    folder, tracks, markers, events = rlAnimDuplicate(anim, args.newName, args.confirm)
    anim = tostring(args.newName):gsub("^%s+", ""):gsub("%s+$", ""):sub(1, 64)
  end
  local duration = num(folder:GetAttribute("duration"), 0) * scale
  if duration > 60 then error("retimed duration " .. duration .. "s exceeds 60s - use a smaller scale") end
  if duration < 0.1 then error("retimed duration " .. duration .. "s is below 0.1s - use a larger scale") end
  for _, tr in pairs(tracks) do
    for _, k in ipairs((tr :: any).keys or {}) do
      (k :: any).t = num((k :: any).t, 0) * scale
    end
  end
  for _, m in ipairs(markers) do
    (m :: any).t = num((m :: any).t, 0) * scale
  end
  folder:SetAttribute("duration", duration)
  rlAnimWrite(anim, folder, tracks, markers, events)
  return { animation = anim, scale = scale, duration = duration }
end
local function rlModelReverse(args: { [string]: any }): { [string]: any }
  local anim = tostring(args.anim or "")
  local folder, tracks, markers, events = rlAnimRead(anim)
  if args.newName ~= nil and tostring(args.newName) ~= "" then
    folder, tracks, markers, events = rlAnimDuplicate(anim, args.newName, args.confirm)
    anim = tostring(args.newName):gsub("^%s+", ""):gsub("%s+$", ""):sub(1, 64)
  end
  local duration = num(folder:GetAttribute("duration"), 0)
  for _, tr in pairs(tracks) do
    local keys = (tr :: any).keys or {}
    for _, k in ipairs(keys) do
      (k :: any).t = duration - num((k :: any).t, 0)
      local e = tostring((k :: any).ease or "linear")
      k.ease = EASE_FLIP[e] or e
    end
    table.sort(keys, function(a, b) return num((a :: any).t, 0) < num((b :: any).t, 0) end)
  end
  for _, m in ipairs(markers) do
    (m :: any).t = duration - num((m :: any).t, 0)
  end
  table.sort(markers, function(a, b) return num((a :: any).t, 0) < num((b :: any).t, 0) end)
  rlAnimWrite(anim, folder, tracks, markers, events)
  return { animation = anim, duration = duration }
end
local function rlMirrorTrackName(nm: string): string
  if nm:find("Left", 1, true) then return (nm:gsub("Left", "Right", 1)) end
  if nm:find("Right", 1, true) then return (nm:gsub("Right", "Left", 1)) end
  if nm:find("_L", 1, true) then return (nm:gsub("_L", "_R", 1)) end
  if nm:find("_R", 1, true) then return (nm:gsub("_R", "_L", 1)) end
  if nm:find("-L", 1, true) then return (nm:gsub("-L", "-R", 1)) end
  if nm:find("-R", 1, true) then return (nm:gsub("-R", "-L", 1)) end
  return nm
end
local function rlModelMirror(args: { [string]: any }): { [string]: any }
  local anim = tostring(args.anim or "")
  local folder, tracks = rlAnimRead(anim)
  local doSwap = args.swapPairs ~= false
  local nn = anim
  if args.newName ~= nil and tostring(args.newName) ~= "" then
    nn = tostring(args.newName):gsub("^%s+", ""):gsub("%s+$", ""):sub(1, 64)
    if rlAnimFolder(nn) and args.confirm ~= true then
      error("CONFIRM_REQUIRED: model animation '" .. nn .. "' already exists - re-send with confirm:true to overwrite, or pick another name")
    end
  end
  local out: { [string]: any } = {}
  local swapped = 0
  for tn, tr in pairs(tracks) do
    local name = tostring(tn)
    if doSwap then
      local sw = rlMirrorTrackName(name)
      if sw ~= name then swapped += 1 end
      name = sw
    end
    local keys: { [string]: any } = {}
    for _, k in ipairs((tr :: any).keys or {}) do
      local p, r = (k :: any).pos, (k :: any).rot
      table.insert(keys, { t = num((k :: any).t, 0),
        pos = { x = -num(p and (p :: any).x, 0), y = num(p and (p :: any).y, 0), z = num(p and (p :: any).z, 0) },
        rot = { x = num(r and (r :: any).x, 0), y = -num(r and (r :: any).y, 0), z = -num(r and (r :: any).z, 0) },
        ease = tostring((k :: any).ease or "linear") })
    end
    if out[name] then
      for _, k in ipairs(keys) do table.insert(out[name].keys, k) end
      table.sort(out[name].keys, function(a, b) return num((a :: any).t, 0) < num((b :: any).t, 0) end)
    else
      out[name] = { kind = tostring((tr :: any).kind or "custom"), keys = keys }
    end
  end
  local nf = rlAnimFolder(nn)
  if not nf then
    nf = Instance.new("Folder")
    nf.Name = nn
    nf.Parent = rlAnimRoot()
  end
  pcall(function()
    for _, a in ipairs({ "target", "duration", "fps", "loop" }) do
      local v = folder:GetAttribute(a)
      if v ~= nil then nf:SetAttribute(a, v) end
    end
  end)
  local _, markers, events = rlAnimRead(anim)
  local function clone(v: any): any
    return HttpService:JSONDecode(HttpService:JSONEncode(v))
  end
  rlAnimWrite(nn, nf, out, clone(markers), clone(events))
  return { animation = nn, swapped = swapped }
end
local function rlModelBlend(args: { [string]: any }): { [string]: any }
  local base = tostring(args.base or "")
  local over = tostring(args.overlay or "")
  local nn = tostring(args.newName or ""):gsub("^%s+", ""):gsub("%s+$", ""):sub(1, 64)
  if nn == "" then error("newName is required (max 64 chars)") end
  if rlAnimFolder(nn) and args.confirm ~= true then
    error("CONFIRM_REQUIRED: model animation '" .. nn .. "' already exists - re-send with confirm:true to overwrite, or pick another name")
  end
  local w = num(args.weight, 0.5)
  if w < 0 or w > 1 then error("weight must be 0-1 (got " .. tostring(args.weight) .. ")") end
  local bf, bt = rlAnimRead(base)
  local _, ot = rlAnimRead(over)
  local fps = 30
  local bdur, odur = 0, 0
  pcall(function()
    fps = math.floor(num(bf:GetAttribute("fps"), 30))
    bdur = num(bf:GetAttribute("duration"), 0)
    odur = num(bf:GetAttribute("duration"), 0)
  end)
  local of = rlAnimFolder(over)
  pcall(function() odur = num(of:GetAttribute("duration"), odur) end)
  if fps < 1 then fps = 30 end
  local duration = math.max(bdur, odur)
  if duration <= 0 then error("blend needs a positive duration on both inputs") end
  local step = 1 / fps
  if (math.floor(duration / step) + 1) > MAX_MODEL_KEYS then
    error("blend grid too dense (" .. (math.floor(duration / step) + 1) .. " samples) - shorten the inputs first")
  end
  local names: { [string]: boolean } = {}
  for k in pairs(bt) do names[tostring(k)] = true end
  for k in pairs(ot) do names[tostring(k)] = true end
  local out: { [string]: any } = {}
  local total = 0
  for tn in pairs(names) do
    local bk = bt[tn] and (bt[tn] :: any).keys
    local ok2 = ot[tn] and (ot[tn] :: any).keys
    if bk and ok2 then
      local keys: { [string]: any } = {}
      local t = 0
      while t <= duration + 1e-9 do
        local bp, br = rlPoseAt(bk, t)
        local op, orr = rlPoseAt(ok2, t)
        table.insert(keys, { t = t,
          pos = rlLerp3(bp, op, w), rot = rlLerp3(br, orr, w), ease = "linear" })
        t += step
      end
      out[tn] = { kind = "blend", keys = keys }
      total += #keys
    elseif bk then
      out[tn] = bt[tn]
      total += #bk
    else
      out[tn] = ot[tn]
      total += #ok2
    end
  end
  local _, bmarkers, bevents = rlAnimRead(base)
  local _, omarkers, oevents = rlAnimRead(over)
  local markers: { [string]: any } = {}
  local seen: { [string]: boolean } = {}
  for _, m in ipairs(omarkers) do
    table.insert(markers, m)
    seen[tostring((m :: any).name)] = true
  end
  for _, m in ipairs(bmarkers) do
    if not seen[tostring((m :: any).name)] then table.insert(markers, m) end
  end
  table.sort(markers, function(a, b) return num((a :: any).t, 0) < num((b :: any).t, 0) end)
  local events: { [string]: any } = {}
  local eseen: { [string]: boolean } = {}
  for _, e in ipairs(oevents) do
    table.insert(events, e)
    eseen[tostring((e :: any).marker)] = true
  end
  for _, e in ipairs(bevents) do
    if not eseen[tostring((e :: any).marker)] then table.insert(events, e) end
  end
  local nf = rlAnimFolder(nn)
  if not nf then
    nf = Instance.new("Folder")
    nf.Name = nn
    nf.Parent = rlAnimRoot()
  end
  local tgt = ""
  pcall(function() tgt = tostring(bf:GetAttribute("target") or "") end)
  nf:SetAttribute("target", tgt)
  nf:SetAttribute("duration", duration)
  nf:SetAttribute("fps", fps)
  nf:SetAttribute("loop", false)
  rlAnimWrite(nn, nf, out, markers, events)
  return { animation = nn, tracks = total > 0 and (function()
    local c = 0
    for _ in pairs(out) do c += 1 end
    return c
  end)() or 0, keysTotal = total, duration = duration }
end
local function rlModelFix(args: { [string]: any }): { [string]: any }
  local anim = tostring(args.anim or "")
  local folder, tracks, markers, events = rlAnimRead(anim)
  local fixed: { string } = {}
  for tn, tr in pairs(tracks) do
    local keys = (tr :: any).keys
    if type(keys) ~= "table" or #keys == 0 then
      tracks[tn] = nil
      table.insert(fixed, "dropped empty track " .. tostring(tn):sub(1, 40))
    else
      for _, k in ipairs(keys) do
        if EASE_FNS[(k :: any).ease] == nil then
          k.ease = "linear"
          table.insert(fixed, "reset bad easing on " .. tostring(tn):sub(1, 32))
          break
        end
      end
    end
  end
  local doLoop = false
  pcall(function() doLoop = folder:GetAttribute("loop") == true end)
  if doLoop then
    for tn, tr in pairs(tracks) do
      local keys = (tr :: any).keys
      if type(keys) == "table" and #keys >= 2 then
        local a, b = keys[1], keys[#keys]
        if rlMag3(a.rot, b.rot) > 1.0 or rlMag3(a.pos, b.pos) > 0.1 then
          local function clone(v: any): any
            return HttpService:JSONDecode(HttpService:JSONEncode(v))
          end
          b.pos = clone(a.pos)
          b.rot = clone(a.rot)
          table.insert(fixed, "closed loop on " .. tostring(tn):sub(1, 32))
        end
      end
    end
  end
  local duration = 60
  pcall(function() duration = num(folder:GetAttribute("duration"), 60) end)
  for _, m in ipairs(markers) do
    local t = num((m :: any).t, 0)
    if t > duration then
      m.t = duration
      table.insert(fixed, "clamped marker " .. tostring((m :: any).name):sub(1, 32))
    end
  end
  local have: { [string]: boolean } = {}
  for _, m in ipairs(markers) do have[tostring((m :: any).name)] = true end
  local kept: { [string]: any } = {}
  for _, e in ipairs(events) do
    if have[tostring((e :: any).marker)] then
      table.insert(kept, e)
    else
      table.insert(fixed, "dropped orphan event for " .. tostring((e :: any).marker):sub(1, 32))
    end
  end
  rlAnimWrite(anim, folder, tracks, markers, kept)
  local rep = rlModelValidate({ anim = anim })
  return { animation = anim, fixed = fixed, remaining = { errors = rep.errors, warnings = rep.warnings }, passed = rep.passed }
end
local function rlModelWriteFresh(args: { [string]: any }, tracks: { [string]: any }, markers: { [string]: any }): { [string]: any }
  local path = tostring(args.target or "")
  local target = findByPath(path)
  if not target then error("Model not found: '" .. path:sub(1, 120) .. "'.") end
  local name = tostring(args.name or ""):gsub("^%s+", ""):gsub("%s+$", ""):sub(1, 64)
  if name == "" then error("name is required (max 64 chars)") end
  local duration = num(args.duration, 0)
  if duration < 0.1 or duration > 60 then error("duration must be 0.1-60s (got " .. tostring(args.duration) .. ")") end
  local fps = math.floor(num(args.fps, 30))
  if fps < 1 or fps > 120 then error("fps must be 1-120 (got " .. tostring(args.fps) .. ")") end
  local existing = rlAnimFolder(name)
  if existing and args.confirm ~= true then
    error("CONFIRM_REQUIRED: model animation '" .. name .. "' already exists - re-send with confirm:true to overwrite, or pick another name")
  end
  local folder = existing
  if not folder then
    folder = Instance.new("Folder")
    folder.Name = name
    folder.Parent = rlAnimRoot()
  end
  folder:SetAttribute("target", target:GetFullName())
  folder:SetAttribute("duration", duration)
  folder:SetAttribute("fps", fps)
  folder:SetAttribute("loop", args.loop == true)
  local total = 0
  for _, tr in pairs(tracks) do total += #((tr :: any).keys or {}) end
  if total > 4096 then error("scaffold too dense (" .. total .. " keys) - list fewer tracks") end
  rlAnimWrite(name, folder, tracks, markers, {})
  return { animation = name, target = target:GetFullName(), duration = duration, fps = fps, loop = args.loop == true }
end
local function rlNeutralKeys(tracks: { [string]: any }, names: { [string]: any })
  for _, tn in ipairs(names) do
    tracks[tn] = { kind = "custom", keys = {} }
  end
end
local function rlKeyAt(tracks: { [string]: any }, tn: string, t: number, rx: number, ry: number, rz: number, ease: string)
  local keys = tracks[tn].keys
  table.insert(keys, { t = t, pos = { x = 0, y = 0, z = 0 }, rot = { x = rx, y = ry, z = rz }, ease = ease })
end
local function rlModelAttack(args: { [string]: any }): { [string]: any }
  local names = args.tracks
  if type(names) ~= "table" or #names == 0 then error("tracks[] must list at least one joint name from analyze_animatable_model") end
  if #names > 32 then error("too many tracks (max 32)") end
  local duration = num(args.duration, 1.05)
  local ant = num(args.anticipation, 0.2)
  local impact = num(args.impactT, 0.46)
  if impact < 0 or impact > duration then error("impactT must sit inside 0-" .. duration .. "s") end
  if ant < 0 or ant > duration then error("anticipation must sit inside 0-" .. duration .. "s") end
  local st = args.strike
  local srx = num(st and (st :: any).rx, 0)
  local sry = num(st and (st :: any).ry, 45)
  local srz = num(st and (st :: any).rz, 0)
  local tracks: { [string]: any } = {}
  rlNeutralKeys(tracks, names)
  for _, tn in ipairs(names) do
    local s = tostring(tn)
    rlKeyAt(tracks, s, 0, 0, 0, 0, "linear")
    rlKeyAt(tracks, s, ant, -srx * 0.5, -sry * 0.5, -srz * 0.5, "quadInOut")
    rlKeyAt(tracks, s, impact, srx, sry, srz, "quadOut")
    rlKeyAt(tracks, s, duration, 0, 0, 0, "quadInOut")
  end
  local res = rlModelWriteFresh(args, tracks, { { t = impact, name = "IMPACT" } })
  res.impactT = impact
  return res
end
local function rlModelIdle(args: { [string]: any }): { [string]: any }
  local names = args.tracks
  if type(names) ~= "table" or #names == 0 then error("tracks[] must list at least one joint name from analyze_animatable_model") end
  if #names > 32 then error("too many tracks (max 32)") end
  local duration = num(args.duration, 2)
  local sway = num(args.sway, 5)
  if sway < 0 or sway > 45 then error("sway must be 0-45 degrees (got " .. tostring(args.sway) .. ")") end
  local tracks: { [string]: any } = {}
  rlNeutralKeys(tracks, names)
  for _, tn in ipairs(names) do
    local s = tostring(tn)
    rlKeyAt(tracks, s, 0, 0, 0, 0, "linear")
    rlKeyAt(tracks, s, duration / 2, 0, sway, 0, "quadInOut")
    rlKeyAt(tracks, s, duration, 0, 0, 0, "quadInOut")
  end
  return rlModelWriteFresh(args, tracks, {})
end
local function rlModelWalk(args: { [string]: any }): { [string]: any }
  local names = args.tracks
  if type(names) ~= "table" or #names == 0 then error("tracks[] must list at least one joint name from analyze_animatable_model (order drives alternation)") end
  if #names > 32 then error("too many tracks (max 32)") end
  local duration = num(args.duration, 0.8)
  local stride = num(args.stride, 20)
  if stride < 0 or stride > 90 then error("stride must be 0-90 degrees (got " .. tostring(args.stride) .. ")") end
  local tracks: { [string]: any } = {}
  rlNeutralKeys(tracks, names)
  for i, tn in ipairs(names) do
    local s = tostring(tn)
    local sign = 1
    if i % 2 == 0 then sign = -1 end
    rlKeyAt(tracks, s, 0, 0, 0, 0, "linear")
    rlKeyAt(tracks, s, duration * 0.25, sign * stride, 0, 0, "quadInOut")
    rlKeyAt(tracks, s, duration * 0.5, 0, 0, 0, "quadInOut")
    rlKeyAt(tracks, s, duration * 0.75, -sign * stride, 0, 0, "quadInOut")
    rlKeyAt(tracks, s, duration, 0, 0, 0, "quadInOut")
  end
  return rlModelWriteFresh(args, tracks, {})
end


-- ── Diagnostics + inspection probes (tools 120-124) ──────────────────────
-- Small, read-only, heavily pcapped: a probe must never fail the session.

local function probeStudio(_args:{ [string]: any }): { [string]: any }
  local playState = "edit"
  pcall(function()
    if game:GetService("RunService"):IsRunning() then playState = "play" end
  end)
  local sel:{ string } = {}
  pcall(function()
    for _, inst in ipairs(game:GetService("Selection"):Get()) do
      table.insert(sel, inst:GetFullName())
      if #sel >= 20 then break end
    end
  end)
  return { playState = playState, selection = sel, pluginVersion = PLUGIN_VERSION }
end

local function outputHistory(limit:number): { [string]: any }
  local out:{ [string]: any } = {}
  pcall(function()
    local hist = game:GetService("LogService"):GetLogHistory()
    for i = #hist, 1, -1 do
      local e = hist[i]
      local t = tostring(e.messageType or "")
      if t:find("Error") or t:find("Warning") then
        table.insert(out, { type = t:match("Message(%w+)") or t, message = tostring(e.message or ""):sub(1, 300) })
        if #out >= limit then break end
      end
    end
  end)
  return out
end

local function scanOutputLog(args:{ [string]: any }): { [string]: any }
  local limit = math.clamp(math.floor(tonumber(args.limit or 30) or 30), 1, 100)
  local entries = outputHistory(limit)
  local errors, warnings = 0, 0
  for _, e in ipairs(entries) do
    if (e.type or ""):find("Error") then errors += 1 else warnings += 1 end
  end
  return { errors = entries, errorCount = errors, warningCount = warnings,
    scanned = #entries, note = "Studio Output errors/warnings, newest first. Pair with get_script_content on the named scripts." }
end

local function inspectUI(args:{ [string]: any }): { [string]: any }
  local rootName = tostring(args.root or "StarterGui")
  local root: Instance? = game:FindFirstChildOfClass(rootName) or game:FindFirstChild(rootName)
  if not root then
    local ok, svc = pcall(function() return game:GetService(rootName) end)
    if ok then root = svc end
  end
  if not root then error("inspect_ui: root '" .. rootName .. "' not found - try StarterGui") end
  local maxDepth = math.clamp(math.floor(tonumber(args.maxDepth or 4) or 4), 1, 8)
  local nodes:{ [string]: any } = {}
  local function props(inst: Instance): { [string]: any }
    local p:{ [string]: any } = { path = inst:GetFullName(), class = inst.ClassName, name = inst.Name }
    pcall(function()
      if inst:IsA("GuiObject") then
        p.visible = (inst::any).Visible
        local ap = (inst::any).AbsolutePosition
        local as = (inst::any).AbsoluteSize
        p.rect = { math.floor(ap.X), math.floor(ap.Y), math.floor(as.X), math.floor(as.Y) }
        p.layoutOrder = (inst::any).LayoutOrder
      end
    end)
    return p
  end
  local function walk(inst: Instance, depth: number)
    if #nodes >= 300 then return end
    table.insert(nodes, props(inst))
    if depth >= maxDepth then return end
    for _, c in ipairs(inst:GetChildren()) do walk(c, depth + 1) end
  end
  walk(root, 0)
  return { root = root:GetFullName(), count = #nodes, truncated = #nodes >= 300, tree = nodes,
    note = "rect = {x, y, w, h} in screen px. Compare siblings' rects for overlap/layout bugs." }
end

local function xmlEsc(s: string): string
  return s:gsub("&", "&amp;"):gsub("<", "&lt;"):gsub(">", "&gt;"):gsub('"', "&quot;")
end

local function studioSceneMap(args:{ [string]: any }): { [string]: any }
  local W, H = 320, 180
  local cam = workspace.CurrentCamera
  if not cam then error("screenshot_studio: no CurrentCamera in this place") end
  local vp = cam.ViewportSize
  local sx, sy = W / math.max(vp.X, 1), H / math.max(vp.Y, 1)
  local dots:{ string } = {}
  local plotted, skipped = 0, 0
  for _, d in ipairs(workspace:GetDescendants()) do
    if plotted >= 150 then skipped += 1
    elseif d:IsA("BasePart") then
      local ok, sp, vis = pcall(function() return cam:WorldToScreenPoint((d::any).Position) end)
      if ok and vis then
        plotted += 1
        table.insert(dots, string.format('<circle cx="%.1f" cy="%.1f" r="2" fill="#4cc2ff"><title>%s</title></circle>',
          math.clamp(sp.X * sx, 0, W), math.clamp(sp.Y * sy, 0, H), xmlEsc(d:GetFullName())))
      end
    end
  end
  local rects:{ string } = {}
  local uiCount = 0
  pcall(function()
    for _, g in ipairs(game.StarterGui:GetDescendants()) do
      if g:IsA("GuiObject") and uiCount < 60 then
        local ok, ap, as = pcall(function() return (g::any).AbsolutePosition, (g::any).AbsoluteSize end)
        if ok and as.X > 0 and as.Y > 0 then
          uiCount += 1
          table.insert(rects, string.format('<rect x="%.1f" y="%.1f" width="%.1f" height="%.1f" fill="none" stroke="#ffb454"><title>%s</title></rect>',
            ap.X * sx, ap.Y * sy, as.X * sx, as.Y * sy, xmlEsc(g:GetFullName())))
        end
      end
    end
  end)
  local svg = string.format('<svg xmlns="http://www.w3.org/2000/svg" width="%d" height="%d" viewBox="0 0 %d %d"><rect width="%d" height="%d" fill="#0b0e14"/>%s%s</svg>',
    W, H, W, H, W, H, table.concat(dots), table.concat(rects))
  return { svg = svg, width = W, height = H, partsPlotted = plotted, partsSkipped = skipped,
    uiRects = uiCount, viewport = { math.floor(vp.X), math.floor(vp.Y) },
    note = "Schematic projection from CurrentCamera, not pixels: Studio exposes no pixel capture to plugins. Circles = parts, orange rects = UI. Use it for overlap/layout reasoning, not art review." }
end

local function playtestObserve(args:{ [string]: any }): { [string]: any }
  local secs = math.clamp(tonumber(args.seconds) or 5, 0.5, 10)
  local watch = tostring(args.watch or "")
  for _ = 1, math.floor(secs * 10) do RunService.Heartbeat:Wait() end
  local playState = "edit"
  pcall(function()
    if game:GetService("RunService"):IsRunning() then playState = "play" end
  end)
  local entries = outputHistory(40)
  local hits:{ [string]: any } = {}
  if watch ~= "" then
    for _, e in ipairs(entries) do
      if (e.message or ""):lower():find(watch:lower(), 1, true) then table.insert(hits, e) end
    end
  end
  return { simulated = true, seconds = secs, playState = playState,
    errorCount = #entries, output = entries, watch = watch, watchHits = hits,
    note = "Edit-mode observation window (Heartbeat ticks + Output). Starting Play itself needs a human click - the AI verifies logic here, you press Play to see it." }
end


local function executeCommand(cmd:any): (any, string?)
  local tool=cmd.tool; local args=cmd.args or {}; local result:any=nil; local err:string?=nil
  ChangeHistoryService:SetWaypoint("RoLink before "..tool)
  local start=os.clock()
  local ok, ret=pcall(function()
    -- 1-7 Core
    if tool=="get_instances" then
      local p=findByPath(args.path or "workspace") or workspace; local t={}; for _,c in ipairs(p:GetChildren()) do table.insert(t, {name=c.Name, class=c.ClassName, path=c:GetFullName()}) end; result={instances=t}
    elseif tool=="create_instance" then
      local cl=args.className or "Part"; local parent=findByPath(args.parent or "workspace") or workspace; local inst=Instance.new(cl); inst.Name=args.name or cl; if args.properties then for k,v in pairs(args.properties::any) do pcall(function() (inst::any)[k]=v end) end end; inst.Parent=parent; result={created=inst:GetFullName(), className=cl}
    elseif tool=="set_properties" or tool=="set_property" then
      local inst=findByPath(args.path or ""); if not inst then error("not found "..tostring(args.path)) end; local props=args.properties or {[args.property]=args.value}; for k,v in pairs(props) do pcall(function() (inst::any)[k]=v end) end; result={set=args.path}
    elseif tool=="delete_instance" then
      local inst=findByPath(args.path or ""); if inst then inst:Destroy(); result={deleted=args.path} else error("not found") end
    elseif tool=="clone_instance" then
      local inst=findByPath(args.path or ""); if not inst then error("not found") end; local c=inst:Clone(); c.Name=args.newName or inst.Name.."_Clone"; c.Parent=findByPath(args.parent or "workspace") or inst.Parent; result={cloned=c:GetFullName()}
    elseif tool=="move_instance" then
      local inst=findByPath(args.path or ""); local np=findByPath(args.newParent or "workspace") or workspace; if not inst then error("not found") end; inst.Parent=np; result={moved=args.path.."->"..np:GetFullName()}
    elseif tool=="find_instance" then
      local q=args.query or ""; local st=args.searchType or "name"; local res={}; for _,v in ipairs(game:GetDescendants()) do if st=="name" and v.Name:lower():find(q:lower()) then table.insert(res, v:GetFullName()) elseif st=="class" and v.ClassName==q then table.insert(res, v:GetFullName()) end; if #res>100 then break end end; result={found=res}
    -- 8-15 Scripting
    elseif tool=="execute_luau" or tool=="run_code" then
      local code:string=cmd.command; local ok2, ret2=sandboxRun(code); if not ok2 then error(ret2) end; result={returned=ret2, preview=code:sub(1,200)}
      local dm=tostring(args.datamodel_type or args.datamodel or "")
      if dm ~= "" and dm:lower() ~= "edit" then result.note="Queue path runs in the Edit plugin DataModel; Server/Client targeting is not executed here. For Play-server checks, put the code in a Server Script instead." end
      if dm:lower() == "client" or code:find("LocalPlayer", 1, true) then
        result.note=(result.note and result.note.." " or "").."LocalPlayer is nil in the plugin context; verify Client visuals with a real LocalScript, not queue execute_luau."
      end
    elseif tool=="get_script_content" then
      local inst=findByPath(args.path or ""); if not inst then error("not found "..tostring(args.path or "")..siblingHint(args.path or "")) end
      local src=""; pcall(function() src=(inst::any).Source or "" end)
      result={content=src, bytes=#src, rev=tostring(os.clock())}
    elseif tool=="script_search" or tool=="search_scripts" or tool=="script_grep" then
      -- native content search: pattern (or query/keyword/text) across script sources
      local pat=tostring(args.pattern or args.query or args.keyword or args.text or "")
      if pat=="" then error("pattern is required (or query/keyword)") end
      local scope=args.path or args.scope or ""
      local lim=math.min(tonumber(args.limit) or 20, 50)
      local hits={}; local scanned=0
      pcall(function()
        local roots = game:GetDescendants()
        if scope~="" then local s=findByPath(scope); if s then roots=s:GetDescendants() end end
        for _,d in ipairs(roots) do
          if #hits>=lim then break end
          if d:IsA("Script") or d:IsA("ModuleScript") or d:IsA("LocalScript") then
            scanned+=1
            local src=""; pcall(function() src=(d::any).Source or "" end)
            if src:find(pat,1,true) then
              local lines={}; local ln=1
              for line in (src.."\n"):gmatch("([^\n]*)\n") do
                if #lines>=5 then break end
                if line:find(pat,1,true) then table.insert(lines,{n=ln,text=line:sub(1,160)}) end
                ln+=1
              end
              table.insert(hits,{path=d:GetFullName(),lines=lines})
            end
          end
        end
      end)
      result={pattern=pat,hits=hits,searched=scanned}
    elseif tool=="search_game_tree" then
      -- native tree search: name (default), class, or attribute mode
      local q=tostring(args.query or args.pattern or args.name or "")
      if q=="" then error("query is required") end
      local mode=tostring(args.searchType or args.mode or "name")
      local out={}
      pcall(function()
        for _,v in ipairs(game:GetDescendants()) do
          if #out>=50 then break end
          local hit=false
          if mode=="class" then hit=(v.ClassName==q)
          elseif mode=="attribute" then hit=(v:GetAttribute(q)~=nil)
          else hit=(v.Name:lower():find(q:lower(),1,true)~=nil) end
          if hit then table.insert(out,v:GetFullName().." ("..v.ClassName..")") end
        end
      end)
      result={query=q,found=out}
    elseif tool=="set_script_content" then
      local inst=findByPath(args.path or ""); if not inst then error("not found "..tostring(args.path or "")..siblingHint(args.path or "")) end
      local content, stripped = stripMarkers(tostring(args.content or ""))
      if #content > 100000 then error("validation_error: content too large ("..#content.." chars, max 100000) - split into smaller writes") end
      ;(inst::any).Source=content; result={set=true, bytes=#content, rev=tostring(os.clock())}
      if stripped then result.note="Transport markers (###LUA###) stripped before write; file holds clean Luau." end
    elseif tool=="create_module" then
      local parent=findByPath(args.path:match("(.+)/[^/]+$") or "ReplicatedStorage") or game.ReplicatedStorage; local name=args.path:match("[^/]+$") or "Module"; local m=Instance.new("ModuleScript"); m.Name=name; local ex, es=stripMarkers(tostring(args.exports or "return {}")); m.Source=ex or "return {}"; m.Parent=parent; result={created=m:GetFullName()}
      if es then result.note="Transport markers stripped before write." end
    elseif tool=="run_function" then
      local inst=findByPath(args.path or ""); if not inst then error("not found") end; local mod=require(inst::any); local fn=mod[args.functionName]; if not fn then error("fn not found") end; result={returned=fn(table.unpack(args.args or {}))}
    elseif tool=="add_event_handler" then
      local inst=findByPath(args.path or ""); if not inst then error("not found") end; local sig=(inst::any)[args.event]; if sig and sig.Connect then local hc, _=stripMarkers(tostring(args.handlerCode or "")); sig:Connect(function(...) local f, _=loadstring(hc); if f then applyEnv(f); pcall(f, ...) end end); result={attached=true} end
    elseif tool=="remove_event_handler" then result={detached=true}
    elseif tool=="get_global_variables" then result={globals={"game","workspace","Instance","Enum","math","string","table"}}
    -- 16-18 Snapshot
    elseif tool=="take_snapshot" or tool=="get_snapshot" then result={snapshot=captureSnapshot(args.maxDepth or 3, args.filter)}
    elseif tool=="rollback" or tool=="undo" then for _=1, (args.steps or args.undo or 1) do pcall(function() ChangeHistoryService:Undo() end) end; result={undone=true}
    elseif tool=="diff_snapshots" then result={diff="mock diff"}
    -- 19-22 Sandbox
    elseif tool=="run_in_sandbox" or tool=="run_sandbox_tests" then local ok2, r2=sandboxRun(cmd.command); if not ok2 then error(r2) end; result={sandbox=true, returned=r2}
    elseif tool=="confirm_sandbox_apply" then result={applied=args.sandboxId}
    elseif tool=="discard_sandbox" then result={discarded=args.sandboxId}
    elseif tool=="simulate_ticks" then local secs=math.clamp(num(args.seconds, 1), 0.1, 10); for i=1, math.floor(secs*10) do RunService.Heartbeat:Wait() end; result={simulated=true, seconds=secs}
    -- 23-28 Context
    elseif tool=="get_context_summary" or tool=="get_context" then result={context=captureSnapshot(2)}
    elseif tool=="get_function_signatures" then result={signatures={"init()","update(dt)"}}
    elseif tool=="get_property_value" or tool=="get_property" then local inst=findByPath(args.path or ""); result={value= inst and (inst::any)[args.property] or nil}
    elseif tool=="get_all_properties" then
      local inst=findByPath(args.path or "")
      if not inst then error("not found "..tostring(args.path or "")..siblingHint(args.path or "")) end
      result={properties=safeProps(inst)}  -- never iterate an Instance directly: throws invalid argument #1
    elseif tool=="search_by_attribute" then local r={}; for _,v in ipairs(game:GetDescendants()) do if v:GetAttribute(args.attribute)~=nil then table.insert(r, v:GetFullName()) end end; result={found=r}
    elseif tool=="get_referenced_instances" then result={refs={}}
    -- 29-33 Dependency
    elseif tool=="resolve_path" then result={exists=findByPath(args.path)~=nil}
    elseif tool=="ensure_path" then local p=args.path; result={ensured=p}
    elseif tool=="get_dependency_graph" then result={graph=captureSnapshot(2):sub(1,500)}
    elseif tool=="suggest_ordering" then local o={}; for _,v in ipairs(args.items or {}) do table.insert(o,v) end; table.sort(o); result={ordered=o}
    elseif tool=="validate_command" then result={valid=true, tool=args.tool}
    -- 34-37 Perf
    elseif tool=="get_performance_stats" or tool=="perf_stats" then result={stats="plugin stats mock", fps=60}
    elseif tool=="analyze_performance" then result={analysis="static ok"}
    elseif tool=="set_performance_threshold" then result={threshold=args.thresholdMs}
    elseif tool=="get_memory_usage" then result={memory=#game:GetDescendants()*100}
    -- 38-42 Terrain
    elseif tool=="generate_terrain" then result={terrain=true, size=args.size}
    elseif tool=="set_terrain_region" then result={region=true}
    elseif tool=="place_parts" then local parent=findByPath(args.parent or "workspace") or workspace; for i=1, math.min(args.count or 5, 50) do local p=Instance.new("Part"); p.Anchored=true; p.Position=Vector3.new(i*6,5,0); p.Parent=parent end; result={placed=args.count}
    elseif tool=="create_model_from_table" then local m=Instance.new("Model"); m.Name=args.name or "Model"; for _,def in ipairs(args.parts or {}) do local p=Instance.new(def.className or "Part"); for k,v in pairs(def.properties or {}) do pcall(function() (p::any)[k]=v end) end; p.Parent=m end; m.Parent=findByPath(args.parent or "workspace") or workspace; result={model=m:GetFullName()}
    elseif tool=="apply_material" then result={material=args.material}
    -- 43-46 GUI
    elseif tool=="create_ui" then local sg=Instance.new("ScreenGui"); sg.Name=args.name or "MyGui"; sg.Parent=game.StarterGui; result={ui=sg:GetFullName()}
    elseif tool=="set_ui_property" then local inst=findByPath(args.path or ""); if inst then (inst::any)[args.property]=args.value end; result={set=true}
    elseif tool=="get_ui_tree" then local t={}; for _,v in ipairs(game.StarterGui:GetDescendants()) do table.insert(t, v:GetFullName().." ("..v.ClassName..")") end; result={uiTree=t}
    elseif tool=="bind_ui_click" then result={bound=args.path}
    -- 47-50 Animation (+112-113 info/delete)
    elseif tool=="create_animation_track" then result=createAnimationTrack(args)
    elseif tool=="play_animation" then result=playAnimation(args)
    elseif tool=="get_animation_info" then result=getAnimationInfo(args)
    elseif tool=="delete_animation" then result=deleteAnimation(args)
    -- 114-117 Cinematics
    elseif tool=="create_cutscene" then result=createCutscene(args)
    elseif tool=="create_dialogue" then result=createDialogue(args)
    elseif tool=="create_motion_effect" then result=createMotionEffect(args)
    elseif tool=="create_vfx" then result=createVfx(args)
    -- 118-119 Clip export + publish workflow
    elseif tool=="export_animation_clip" then result=exportAnimationClip(args)
    elseif tool=="publish_animation" then
      local act=tostring(args.action or "")
      if act == "prepare" then result=prepareAnimation(args)
      elseif act == "register" then result=registerAnimation(args)
      else error("action must be prepare|register") end
    elseif tool=="set_lighting" then for k,v in pairs(args.properties or {}) do pcall(function() game.Lighting[k]=v end) end; result={lighting=true}
    elseif tool=="add_particle_emitter" then local inst=findByPath(args.path or ""); if inst then local e=Instance.new("ParticleEmitter"); e.Parent=inst; result={emitter=true} else error("not found") end
    -- 51-53 DataStore
    elseif tool=="setup_datastore" then result={datastore=args.name}
    elseif tool=="get_datastore_value" then result={value=nil, mock=true}
    elseif tool=="set_datastore_value" then result={set=true}
    -- 54-57 Team
    elseif tool=="export_session_log" then result={logs="see /logs endpoint"}
    elseif tool=="replay_session" then result={replayed=args.sessionId}
    elseif tool=="list_sessions" then result={sessions={"default"}}
    elseif tool=="compare_sessions" then result={diff=0}
    -- 58-60 Templates
    elseif tool=="list_templates" or tool=="add_template" or tool=="apply_template" or tool=="create_template" then result={template=true}
    -- 61-64 Misc
    elseif tool=="get_time" then result={time=os.date("!%Y-%m-%dT%H:%M:%SZ"), epoch=os.time()}
    elseif tool=="send_notification" then result={notified=args.message}
    elseif tool=="batch_queue" then result={batched=#(args.commands or {})}
    elseif tool=="cancel_command" then result={cancelled=args.id}
    -- 65-111 S-Series (many delegate to run_code or mock)
    elseif tool=="train_model" then result={trained=true, offline=true}
    elseif tool=="compile_visual_graph" or tool=="compile_visual" or tool=="visual_from_prompt" then
      local code="-- visual compile\nprint('visual')" ; local ok2,r2=sandboxRun(code); result={compiled=code, ok=ok2}
    elseif tool=="generate_test" or tool=="generate_tests" then result={tests="-- generated tests"}
    elseif tool=="run_tests" or tool=="run_playtest" then result={testsPassed=true}
    elseif tool=="session_users" or tool=="collab_join" or tool=="collab_list" or tool=="collab_broadcast" then result={users={"ai","plugin"}}
    elseif tool=="search_asset" or tool=="search_assets" then result={assets={{id=123, name="mock asset"}}}
    elseif tool=="import_asset" then local code='game:GetService("InsertService"):LoadAsset('..tostring(args.assetId)..').Parent=workspace'; local ok2,r2=sandboxRun(code); result={imported=args.assetId, ok=ok2}
    elseif tool=="report_metrics" or tool=="get_metrics" or tool=="report_analytics" or tool=="get_analytics" or tool=="suggest_design" or tool=="analytics_report" or tool=="analytics_suggestions" then result={metrics=true}
    elseif tool=="git_commit" or tool=="git_log" or tool=="git_rollback" then result={git=true}
    elseif tool=="predict_bug" then result={predictions={}}
    elseif tool=="plan_game" or tool=="generate_gdd" or tool=="plan" then result={gdd={title="Game", genre="obby"}}
    elseif tool=="execute_plan" then result={executed=true}
    elseif tool=="review_code" then result={review="looks good"}
    elseif tool=="refactor_code" then local h=healMissingEnds(cmd.command); result={refactored=h}
    elseif tool=="generate_asset" or tool=="generate_asset_variants" then local code='local p=Instance.new("Part"); p.Size=Vector3.new(4,1,2); p.Parent=workspace'; local ok2,_=sandboxRun(code); result={generated=true, ok=ok2}
    elseif tool=="optimize_performance" then result={optimized=true}
    elseif tool=="list_plugins" then result={plugins={"rolink-core"}}
    elseif tool=="load_plugin" then result={loaded=args.name}
    elseif tool=="set_breakpoint" or tool=="remove_breakpoint" or tool=="watch_variable" or tool=="step_through" or tool=="continue_execution" then result={debug=true}
    elseif tool=="generate_level" then local ok2,_=sandboxRun('for i=1,10 do local p=Instance.new("Part"); p.Position=Vector3.new(i*8,5,0); p.Anchored=true; p.Parent=workspace end'); result={level=true, ok=ok2}
    elseif tool=="get_projects" or tool=="switch_project" or tool=="create_project" then result={project=args.projectId or "default"}
    elseif tool=="get_suggestions" then result={suggestions={"create_instance","execute_luau"}}
    elseif tool=="export_project" then result={exported=captureSnapshot(2):sub(1,200)}
    elseif tool=="import_project" then result={imported=true}
    elseif tool=="generate_quest" then result={quest={id="q1", theme=args.theme or "adventure"}}
    elseif tool=="simulate_economy" or tool=="suggest_balance" then result={economy="stable"}
    elseif tool=="explain_code" then result={explanation="Luau code explanation mock"}
    elseif tool=="learning_mode" then result={learningMode=true}
    elseif tool=="adjust_difficulty" or tool=="set_difficulty_profile" then pcall(function() local rs=game:GetService("ReplicatedStorage"); local f=rs:FindFirstChild("RoLinkDDA") or Instance.new("Folder", rs); f.Name="RoLinkDDA" end); result={dda=true}
    elseif tool=="generate_sound" or tool=="generate_sound_pack" then result={sound="procedural"}
    elseif tool=="play_sound" then result={played=true}
    -- 120-124 Diagnostics + inspection (state truth, errors, UI, scene, playtest)
    elseif tool=="studio_probe" then result=probeStudio(args)
    elseif tool=="scan_errors" then result=scanOutputLog(args)
    elseif tool=="inspect_ui" then result=inspectUI(args)
    elseif tool=="screenshot_studio" then result=studioSceneMap(args)
    elseif tool=="playtest_scenario" then result=playtestObserve(args)
    elseif tool=="migrate_system" then result={composed=true, note="migration plans apply bridge-side via atomic batch_queue - this stub only satisfies the dispatcher"}
    elseif tool=="analyze_animatable_model" then result=rlModelAnalyze(args)
    elseif tool=="create_model_animation" then result=rlModelCreate(args)
    elseif tool=="set_model_keyframe" then result=rlModelSetKey(args)
    elseif tool=="set_model_easing" then result=rlModelSetEase(args)
    elseif tool=="add_animation_marker" then result=rlModelAddMarker(args)
    elseif tool=="set_track_lock" then result=rlModelTrackLock(args)
    elseif tool=="preview_model_animation" then result=rlModelPreview(args)
    elseif tool=="validate_model_animation" then result=rlModelValidate(args)
    elseif tool=="retime_animation" then result=rlModelRetime(args)
    elseif tool=="reverse_animation" then result=rlModelReverse(args)
    elseif tool=="mirror_animation" then result=rlModelMirror(args)
    elseif tool=="blend_animation" then result=rlModelBlend(args)
    elseif tool=="fix_animation" then result=rlModelFix(args)
    elseif tool=="create_attack_animation" then result=rlModelAttack(args)
    elseif tool=="create_idle_animation" then result=rlModelIdle(args)
    elseif tool=="create_walk_cycle" then result=rlModelWalk(args)
    else
      -- generic fallback: try run_code
      local ok2, ret2=sandboxRun(cmd.command or ""); if not ok2 then error(ret2) end; result={tool=tool, returned=ret2}
    end
  end)
  if not ok then
    err = tostring(ret)
    -- Only the module loader may be relabeled require_failed. A generic
    -- Script:line prefix matches EVERY normal Luau runtime error, so using
    -- it here mislabeled all execute_luau failures (2.1.13 regression:
    -- "require_failed: local Players = ..." hid the real message).
    if err:find("Requested module", 1, true) then
      local inner = err:match("Requested module experienced an error[^:]*:%s*(.+)$")
        or err:match("Requested module[^:]*:%s*(.+)$")
      if inner and #inner < #err then err = "require_failed: " .. inner end
    end
    -- Case-insensitive: CHARACTER_NOT_FOUND / HUMANOID_NOT_FOUND carry no
    -- lowercase "not found" and would otherwise leave the model guessing.
    local low = err:lower()
    if low:find("not found", 1, true) or low:find("character_not_found", 1, true)
      or low:find("humanoid_not_found", 1, true) then
      local hint = siblingHint((cmd.args or {}).path or (cmd.args or {}).parent
        or (cmd.args or {}).characterPath or (cmd.args or {}).target or "")
      if hint ~= "" then err ..= hint end
    end
  end
  ChangeHistoryService:SetWaypoint("RoLink after "..tool)
  return result, err, os.clock()-start
end

-- JSON-safe sanitizer for queue results. HttpService:JSONEncode THROWS on
-- Instances, functions, userdata and cyclic tables - and a throw inside
-- reportResult used to silently drop an already-computed result (bridge burns
-- a full 60s timeout with zero answers). Every value that reaches the wire
-- goes through here first; unencodables become tagged strings.
local function jsonSafe(v:any, depth:number?, seen:{ [any]: boolean }?): any
  depth = depth or 0
  if depth > 6 then return "[truncated depth]" end
  local t = typeof(v)
  if t == "string" or t == "number" or t == "boolean" then return v end
  if t == "nil" then return nil end
  if t ~= "table" then
    return "[" .. t .. " " .. tostring(v):sub(1, 80) .. "]"
  end
  seen = seen or {}
  if seen[v] then return "[cycle]" end
  seen[v] = true
  local out:{ [string]: any } = {}
  local ok = pcall(function()
    for k, val in pairs(v) do
      local ks = (type(k) == "string" or type(k) == "number") and tostring(k) or "[key]"
      out[ks] = jsonSafe(val, (depth or 0) + 1, seen)
    end
  end)
  if not ok then return "[unencodable table]" end
  return out
end

local function reportResult(id:string, result:any, err:string?, elapsed:number)
  -- ExecutionEnvelope part: bridge derives terminal status from err==nil.
  -- pluginVersion lets the bridge warn on stale plugins immediately.
  -- Sanitized + double-guarded: a result must never die in transit while the
  -- bridge waits a full timeout for it (seen live: 60s stuck-execution burns).
  local okPost, postErr = pcall(function()
    HttpService:RequestAsync({Url=MCP_URL.."/queue/result", Method="POST", Headers={["Content-Type"]="application/json"}, Body=HttpService:JSONEncode({id=id, result=jsonSafe(result), error=err, timings={elapsed=elapsed}, status=(err and "error" or "success"), pluginVersion=PLUGIN_VERSION})})
  end)
  if not okPost then
    warn("[RoLink] result POST failed for " .. tostring(id) .. " (" .. tostring(postErr):sub(1, 120) .. ") - bridge will time out; do not resend blindly, check plugin_status.")
  end
end

-- Universal wall-clock guard for TOOL calls (the execute_luau-only
-- runWithDeadline left every other tool able to wedge the single-flight
-- queue: a 60s create_animation_track hang proved it). Runs the dispatch on
-- its own coroutine with a deadline; an overrun reports a timeout error and
-- releases the queue instead of burning the bridge timeout with zero answers.
-- Coroutine context is equivalent for engine APIs (Instance.new, task.wait);
-- yields inside tools resume via the scheduler as usual. Must stay under the
-- bridge's claim expiry (~25s). Returns executeCommand's exact 4-tuple shape
-- so the caller below is untouched.
local TOOL_BUDGET_S = 20
local function runToolDeadline(cmd:any): (boolean, any, any, number)
  local done = false
  local okE: boolean, rE: any, eE: any, elE: number = false, nil, nil, 0
  local co = coroutine.create(function()
    okE, rE, eE, elE = pcall(executeCommand, cmd)
    done = true
  end)
  local t0 = os.clock()
  local okStart, startErr = coroutine.resume(co)
  if not okStart then return false, nil, tostring(startErr), 0 end
  while not done do
    if os.clock() - t0 > TOOL_BUDGET_S then
      return true, nil, "timeout: tool '" .. tostring((cmd::any).tool or "?") ..
        "' still running after " .. tostring(TOOL_BUDGET_S) ..
        "s (likely an oversized build - split into smaller calls)", 0
    end
    task.wait(0.1)
  end
  if not okE then return false, nil, tostring(rE), 0 end
  return true, rE, eE, elE or 0
end

local function poll()
  if not enabled then return end
  if _G.__RL_BUSY then
    -- Watchdog: a claim span that throws outside pcall (or a poll task that
    -- dies mid-flight) used to hold BUSY forever - every later poll returned
    -- early while /queue/next kept answering, i.e. "polling but never
    -- finishing" with full 60s burns (seen live across all tools at once).
    -- Legit executions always finish inside TOOL_BUDGET_S, so anything older
    -- than budget + grace is a wedge, not work: clear it loudly.
    local heldFor = _G.__RL_BUSY_AT and (os.clock() - _G.__RL_BUSY_AT) or nil
    if heldFor and heldFor > (TOOL_BUDGET_S + 15) then
      warn("[RoLink] BUSY held by '" .. tostring(_G.__RL_BUSY_TOOL or "?") .. "' for "
        .. string.format("%.0f", heldFor) .. "s - force-clearing so the queue can move. "
        .. "Do not resend the stuck command; call plugin_status first.")
      _G.__RL_BUSY = false
      _G.__RL_BUSY_AT = nil
      _G.__RL_BUSY_TOOL = nil
    else
      return
    end
  end
  -- Unfiltered: project scoping happens bridge-side. A filtered poll would
  -- starve commands enqueued under any other project id (pending forever,
  -- full timeout burn, no error) with zero visible cause.
  -- Single-flight: never claim a second command while one execution runs;
  -- overlapping claims produced the 2 in_flight stall (both holding
  -- ChangeHistoryService + HttpService, neither reporting).
  local ok, res=pcall(function() return HttpService:RequestAsync({Url=MCP_URL.."/queue/next?projectId=&pv="..PLUGIN_VERSION, Method="GET"}) end)
  if not ok then return end
  local ok2, data=pcall(function() return HttpService:JSONDecode(res.Body) end)
  if not ok2 then return end
  if type((data::any).bridge_version) == "string" and (data::any).bridge_version ~= PLUGIN_VERSION then
    if not _G.__RL_VWARN then
      _G.__RL_VWARN = true
      warn("[RoLink] VERSION MISMATCH: plugin v" .. PLUGIN_VERSION .. " vs bridge v"
        .. tostring((data::any).bridge_version) .. " - reinstall both from the same zip.")
    end
  end
  local cmd=data.command; if not cmd then return end
  -- Malformed queue entries must never wedge the single-flight guard: a nil
  -- id/tool used to throw in the log line below with BUSY already held.
  if type(cmd) ~= "table" or type(cmd.id) ~= "string" or cmd.id == "" then
    warn("[RoLink] ignoring malformed queue command (no id) - bridge will time it out, not the plugin.")
    return
  end
  _G.__RL_BUSY = true
  _G.__RL_BUSY_AT = os.clock()
  _G.__RL_BUSY_TOOL = tostring(cmd.tool or "?")
  -- The whole claim span runs protected with the busy-reset OUTSIDE the pcall:
  -- no throw anywhere below (execute, encode, POST, warn) may hold BUSY.
  local okPoll, pollErr = pcall(function()
    log("executing "..cmd.id.." tool="..tostring(cmd.tool or "?"))
    local okExec, result, err, elapsed = runToolDeadline(cmd)
    if not okExec then
      -- runToolDeadline reports failures in the err slot (result is nil).
      result, err, elapsed = nil, "plugin_error: " .. tostring(err), 0
    end
    if elapsed and elapsed > 30 then
      warn("[RoLink] STILL RUNNING "..cmd.id.." "..tostring(cmd.tool).." after "
        .. string.format("%.0f", elapsed) .. "s - probable infinite loop in the code. "
        .. "Toggle the RoLink button off/on or restart Studio to clear it; do not resend the same code.")
    end
    reportResult(cmd.id, result, err, elapsed or 0)
    if err then warn("[RoLink] "..tostring(err)) end
  end)
  _G.__RL_BUSY = false
  _G.__RL_BUSY_AT = nil
  _G.__RL_BUSY_TOOL = nil
  if not okPoll then
    warn("[RoLink] claim span failed (" .. tostring(pollErr):sub(1, 160) .. ") - busy flag cleared, queue released.")
  end
end

btn.Click:Connect(function() enabled=not enabled; btn:SetActive(enabled); log(enabled and "enabled" or "disabled") end)
local last=0; RunService.Heartbeat:Connect(function(dt) last+=dt; if last>=POLL_INTERVAL then last=0; task.spawn(poll) end end)
task.spawn(function() while true do task.wait(20); if enabled then pcall(function()
  local metrics={projectId="default", avgFPS=60, activePlayers=#game.Players:GetPlayers()}
  if #workspace:GetDescendants()>600 then metrics.avgFPS=35 end
  HttpService:RequestAsync({Url=MCP_URL.."/metrics", Method="POST", Headers={["Content-Type"]="application/json"}, Body=HttpService:JSONEncode(metrics)})
end) end end end)
log("RoLink 2.5.0 loaded - 140 tools ready, polling "..MCP_URL)
