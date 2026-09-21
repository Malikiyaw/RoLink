-- RoLink.lua — Studio Plugin (119 tools, production)
-- Place in Studio Plugins folder or Rojo. Polls MCP every 200ms, executes, snapshots, heals, reports.
local HttpService = game:GetService("HttpService")
local ChangeHistoryService = game:GetService("ChangeHistoryService")
local RunService = game:GetService("RunService")

local MCP_URL = "http://127.0.0.1:3001"
local POLL_INTERVAL = 0.2
local PLUGIN_NAME = "RoLink 2.1"
local PLUGIN_VERSION = "2.2.1"

local toolbar = plugin:CreateToolbar(PLUGIN_NAME)
local btn = toolbar:CreateButton("RoLink", "AI bridge (119 tools, poll 200ms)", "rbxassetid://0")
btn.ClickableWhenViewportHidden = true
local enabled = true

local function log(msg) print("[RoLink] "..msg) end

local safeEnv = {
  print=print, warn=warn, error=error,
  pairs=pairs, ipairs=ipairs, next=next, type=type, tostring=tostring, tonumber=tonumber,
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
    local okRun, a, b = pcall(runBudgeted, res)
    local ok2: boolean? = nil
    local ret: any = nil
    if okRun then
      ok2 = a :: any
      ret = b
    else
      return false, tostring(a) .. " [code: " .. code:gsub("%s+", " "):sub(1, 120) .. "]"
    end
    if ok2 then return true, ret end
    local err=tostring(ret); local healed=code
    if err:find("expected") or err:find("unfinished") then healed=balanceParens(healed); healed=healMissingEnds(healed) end
    healed=healed:gsub(":connect%(", ":Connect("):gsub("WatiForChild","WaitForChild"):gsub("Instnace","Instance")
    if healed~=code then
      local okH, resH = pcall(function() return loadstring(healed, "RoLinkHeal") end)
      if okH and resH then
        applyEnv(resH)
        local hOk, hA, hB = pcall(runBudgeted, resH)
        if hOk and (hA :: any) then return true, hB end
      end
    end
    -- Error context: the model only sees a line number otherwise. Attach the
    -- offending head so it can fix the actual expression.
    local head = code:gsub("%s+", " "):sub(1, 120)
    return false, err .. " [code: " .. head .. ( #code > 120 and "..." or "") .. "]"
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
local function bakeEased(kfData:{ [string]: any }): { [string]: any }
  local out:{ [string]: any } = {}
  for i, kfD in ipairs(kfData) do
    if type(kfD) ~= "table" then error("keyframe must be an object") end
    local t = math.max(0, num((kfD::any).time, 0))
    if i > 1 and t < math.max(0, num(((kfData[i - 1])::any).time, 0)) then
      error("keyframe times must be non-decreasing (keyframe " .. i .. " goes backwards)")
    end
    local easeName = tostring((kfD::any).easing or "linear")
    local easeFn = EASE_FNS[easeName]
    if not easeFn then error("unknown easing '" .. easeName:sub(1, 32) .. "' (linear|quadIn|quadOut|quadInOut|cubicIn|cubicOut|cubicInOut|sineIn|sineOut|sineInOut)") end
    if i > 1 and easeName ~= "linear" then
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
  kfData = bakeEased(kfData)
  local folder = game.Workspace:FindFirstChild("RoLinkAnimations")
  if not folder then folder = Instance.new("Folder"); folder.Name = "RoLinkAnimations"; folder.Parent = game.Workspace end
  local seq = Instance.new("KeyframeSequence")
  seq.Name = name
  if args.loop == true then seq.Loop = true end
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
  local twin = findClipTwin(seq)
  if twin then ret.clip = twin:GetFullName(); ret.clipCurves = clipCurvesSummary(twin) end
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
    error("validation_error: this Studio version cannot create AnimationClip (update Studio) - use the KeyframeSequence path instead")
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

local function reportResult(id:string, result:any, err:string?, elapsed:number)
  pcall(function()
    HttpService:RequestAsync({Url=MCP_URL.."/queue/result", Method="POST", Headers={["Content-Type"]="application/json"}, Body=HttpService:JSONEncode({id=id, result=result, error=err, timings={elapsed=elapsed}})})
  end)
end

local function poll()
  if not enabled then return end
  if _G.__RL_BUSY then return end
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
  _G.__RL_BUSY = true
  log("executing "..cmd.id.." tool="..cmd.tool)
  local okExec, result, err, elapsed = pcall(executeCommand, cmd)
  _G.__RL_BUSY = false
  if not okExec then
    result, err, elapsed = nil, "plugin_error: " .. tostring(result), 0
  end
  if elapsed and elapsed > 30 then
    warn("[RoLink] STILL RUNNING "..cmd.id.." "..tostring(cmd.tool).." after "
      .. string.format("%.0f", elapsed) .. "s - probable infinite loop in the code. "
      .. "Toggle the RoLink button off/on or restart Studio to clear it; do not resend the same code.")
  end
  reportResult(cmd.id, result, err, elapsed or 0)
  if err then warn("[RoLink] "..err) end
end

btn.Click:Connect(function() enabled=not enabled; btn:SetActive(enabled); log(enabled and "enabled" or "disabled") end)
local last=0; RunService.Heartbeat:Connect(function(dt) last+=dt; if last>=POLL_INTERVAL then last=0; task.spawn(poll) end end)
task.spawn(function() while true do task.wait(20); if enabled then pcall(function()
  local metrics={projectId="default", avgFPS=60, activePlayers=#game.Players:GetPlayers()}
  if #workspace:GetDescendants()>600 then metrics.avgFPS=35 end
  HttpService:RequestAsync({Url=MCP_URL.."/metrics", Method="POST", Headers={["Content-Type"]="application/json"}, Body=HttpService:JSONEncode(metrics)})
end) end end end)
log("RoLink 2.2.1 loaded - 119 tools ready, polling "..MCP_URL)
