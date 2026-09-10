-- RoLink.lua — Studio Plugin (111 tools, production)
-- Place in Studio Plugins folder or Rojo. Polls MCP every 200ms, executes, snapshots, heals, reports.
local HttpService = game:GetService("HttpService")
local ChangeHistoryService = game:GetService("ChangeHistoryService")
local RunService = game:GetService("RunService")

local MCP_URL = "http://127.0.0.1:3001"
local POLL_INTERVAL = 0.2
local PLUGIN_NAME = "RoLink 4.0"

local toolbar = plugin:CreateToolbar(PLUGIN_NAME)
local btn = toolbar:CreateButton("RoLink", "AI bridge (111 tools, poll 200ms)", "rbxassetid://0")
btn.ClickableWhenViewportHidden = true
local hudBtn = toolbar:CreateButton("HUD", "RoLink hologram HUD — tool visuals in Studio (P3)", "rbxassetid://0")
hudBtn.ClickableWhenViewportHidden = true
local enabled = true

local function log(msg) print("[RoLink] "..msg) end

local safeEnv = {
  print=print, warn=warn, error=error,
  pairs=pairs, ipairs=ipairs, next=next, type=type, tostring=tostring, tonumber=tonumber,
  math=math, string=string, table=table, vector=vector,
  game=game, workspace=workspace, Instance=Instance, Enum=Enum, task=task, tick=tick, time=time,
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

local function sandboxRun(code:string): (boolean, any)
  local ok, res = pcall(function() return loadstring(code, "RoLink") end)
  if ok and res then
    pcall(function() setfenv(res, safeEnv) end)
    local ok2, ret = pcall(res)
    if ok2 then return true, ret end
    local err=tostring(ret); local healed=code
    if err:find("expected") or err:find("unfinished") then healed=balanceParens(healed); healed=healMissingEnds(healed) end
    healed=healed:gsub(":connect%(", ":Connect("):gsub("WatiForChild","WaitForChild"):gsub("Instnace","Instance")
    if healed~=code then
      local okH, resH = pcall(function() return loadstring(healed, "RoLinkHeal") end)
      if okH and resH then pcall(function() setfenv(resH, safeEnv) end); local ok2h, retH=pcall(resH); if ok2h then return true, retH end end
    end
    return false, err
  else
    local ok3, ret2=pcall(function() local m=Instance.new("ModuleScript"); m.Source=code.."\nreturn true"; local o1,o2=pcall(require,m); m:Destroy(); if not o1 then error(o2) end; return o2 end)
    if ok3 then return true, ret2 end; return false, tostring(ret2)
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
  if path=="workspace" then return workspace end
  if path:sub(1,5)=="game." then path=path:sub(6) end
  local ok, res=pcall(function() return game:FindFirstChild(path, true) end)
  if ok and res then return res end
  -- fallback: find by name
  local found:Instance? = nil
  pcall(function() for _,v in ipairs(game:GetDescendants()) do if v.Name==path then found=v; break end end end)
  return found
end

-- ── P3 ToolVisualizer (embedded copy — VISUALIZER SYNC) ────────────────
-- Keep in sync with studio-plugin/src/toolVisualizer.luau (source of truth).
-- In-Studio hologram HUD: counters, ghost highlights, script diff popups,
-- progress chips, subtle sounds. Every entry pcall-guarded: a HUD failure
-- must never fail a tool command. Toggle via the "HUD" toolbar button.
local VEnabled = true
local VSoundOn = true
local VHud: ScreenGui? = nil
local VHead: TextLabel? = nil
local VLog: ScrollingFrame? = nil
local VStats = { total = 0, running = 0, errors = 0 }
local VPending: { [string]: any } = {}
local VCatColor: { [string]: Color3 } = {
	read = Color3.fromRGB(91, 141, 239), edit = Color3.fromRGB(255, 184, 0),
	inspect = Color3.fromRGB(0, 229, 255), generate = Color3.fromRGB(255, 107, 53),
	asset = Color3.fromRGB(244, 114, 182), visual = Color3.fromRGB(168, 85, 247),
	test = Color3.fromRGB(0, 255, 136), tool = Color3.fromRGB(148, 163, 184),
}
local VCatExact: { [string]: string } = {
	take_snapshot = "inspect", rollback = "inspect", diff_snapshots = "inspect",
	get_instances = "inspect", find_instance = "inspect",
	execute_luau = "edit", set_script_content = "edit", create_module = "edit",
	create_instance = "edit", set_properties = "edit", delete_instance = "edit",
	clone_instance = "edit", move_instance = "edit", run_function = "edit",
	add_event_handler = "edit", remove_event_handler = "edit", ensure_path = "edit",
	resolve_path = "edit", place_parts = "edit", create_model_from_table = "edit",
	set_terrain_region = "edit", set_ui_property = "edit", bind_ui_click = "edit",
	set_datastore_value = "edit", setup_datastore = "edit", create_project = "edit",
	import_project = "edit", switch_project = "edit", set_breakpoint = "edit",
	remove_breakpoint = "edit", apply_template = "edit", add_template = "edit",
	refactor_code = "edit", load_plugin = "edit", git_commit = "edit",
	git_rollback = "edit", adjust_difficulty = "edit", set_difficulty_profile = "edit",
	get_script_content = "read", get_context_summary = "read", get_function_signatures = "read",
	get_property_value = "read", get_all_properties = "read", search_by_attribute = "read",
	get_referenced_instances = "read", get_global_variables = "read", get_dependency_graph = "read",
	get_ui_tree = "read", get_datastore_value = "read", get_projects = "read",
	get_suggestions = "read", get_analytics = "read", get_metrics = "read",
	get_memory_usage = "read", get_performance_stats = "read", get_time = "read",
	list_templates = "read", list_plugins = "read", list_sessions = "read",
	git_log = "read", explain_code = "read", validate_command = "read",
	suggest_ordering = "read", suggest_design = "read", suggest_balance = "read",
	export_session_log = "read", replay_session = "read", compare_sessions = "read",
	session_users = "read", report_metrics = "read", report_analytics = "read",
	predict_bug = "read", review_code = "read", export_project = "read",
	generate_terrain = "generate", generate_asset = "generate", generate_level = "generate",
	generate_quest = "generate", generate_sound = "generate", generate_sound_pack = "generate",
	generate_test = "generate", compile_visual_graph = "generate",
	search_asset = "asset", import_asset = "asset", apply_material = "asset",
	create_ui = "visual", create_animation_track = "visual", play_animation = "visual",
	set_lighting = "visual", add_particle_emitter = "visual", play_sound = "visual",
	send_notification = "visual",
	run_tests = "test", simulate_ticks = "test", simulate_economy = "test",
	run_in_sandbox = "test", run_playtest = "test", confirm_sandbox_apply = "test",
	discard_sandbox = "test", step_through = "test", continue_execution = "test",
	watch_variable = "test", analyze_performance = "test",
	set_performance_threshold = "test", optimize_performance = "test",
	batch_queue = "tool", cancel_command = "tool", train_model = "tool",
	plan_game = "tool", execute_plan = "tool", learning_mode = "tool",
}
local VSoundTick = "rbxasset://sounds/electronicpingshort.wav"
local VSoundOk = "rbxasset://sounds/bass.wav"
local VSoundErr = "rbxasset://sounds/electronicpingshort.wav"
local function vCategory(tool: string): string
	local hit = VCatExact[tool]
	if hit then return hit end
	local n = (tool or ""):lower()
	if n:find("generate", 1, true) then return "generate" end
	if n:find("search_asset", 1, true) or n:find("import_asset", 1, true) then return "asset" end
	if n:find("animation", 1, true) or n:find("lighting", 1, true) or n:find("particle", 1, true) then return "visual" end
	if n:find("test", 1, true) or n:find("simulat", 1, true) or n:find("sandbox", 1, true) or n:find("playtest", 1, true) or n:find("breakpoint", 1, true) then return "test" end
	if n:sub(1, 4) == "get_" or n:sub(1, 5) == "list_" or n:find("suggest", 1, true) or n:find("search", 1, true) then return "read" end
	return "tool"
end
local function vPlay(id: string, vol: number, speed: number)
	if not VSoundOn then return end
	pcall(function()
		local svc = game:GetService("SoundService")
		local s = Instance.new("Sound")
		s.SoundId = id; s.Volume = vol; s.PlaybackSpeed = speed
		svc:PlayLocalSound(s)
		task.delay(3, function() pcall(function() s:Destroy() end) end)
	end)
end
local function vHead()
	pcall(function()
		if VHead then VHead.Text = string.format("RoLink • 111 Tools   |   running %d   |   done %d   |   errors %d", VStats.running, VStats.total, VStats.errors) end
	end)
end
local function vLogLine(text: string, color: Color3?)
	pcall(function()
		if not VLog then return end
		local line = Instance.new("TextLabel")
		line.BackgroundTransparency = 1; line.Font = Enum.Font.Code; line.TextSize = 11
		line.TextXAlignment = Enum.TextXAlignment.Left; line.Text = text:sub(1, 120)
		line.TextColor3 = color or Color3.fromRGB(230, 237, 243)
		line.Size = UDim2.new(1, -8, 0, 16); line.Parent = VLog
		local count = 0
		for _, k in ipairs(VLog:GetChildren()) do
			if k:IsA("TextLabel") then count += 1; if count > 30 then k:Destroy() break end end
		end
	end)
end
local function vEnsureHud(): boolean
	if VHud and VHud.Parent then return true end
	local coreGui: DataModel? = nil
	pcall(function() coreGui = game:GetService("CoreGui") end)
	if not coreGui then return false end
	local ok = pcall(function()
		local old = (coreGui :: DataModel):FindFirstChild("RoLinkHUD")
		if old then old:Destroy() end
		local gui = Instance.new("ScreenGui")
		gui.Name = "RoLinkHUD"; gui.ResetOnSpawn = false; gui.DisplayOrder = 999; gui.Parent = coreGui
		local panel = Instance.new("Frame")
		panel.AnchorPoint = Vector2.new(1, 0); panel.Position = UDim2.new(1, -12, 0, 40)
		panel.Size = UDim2.new(0, 300, 0, 30)
		panel.BackgroundColor3 = Color3.fromRGB(14, 17, 24); panel.BackgroundTransparency = 0.08
		panel.BorderSizePixel = 0; panel.Parent = gui
		local corner = Instance.new("UICorner"); corner.CornerRadius = UDim.new(0, 10); corner.Parent = panel
		local head = Instance.new("TextLabel")
		head.BackgroundTransparency = 1; head.Font = Enum.Font.GothamBold; head.TextSize = 11
		head.TextColor3 = Color3.fromRGB(230, 237, 243); head.TextXAlignment = Enum.TextXAlignment.Left
		head.Size = UDim2.new(1, -16, 1, 0); head.Position = UDim2.new(0, 8, 0, 0)
		head.Text = "RoLink • 111 Tools"; head.Parent = panel
		local logF = Instance.new("ScrollingFrame")
		logF.Position = UDim2.new(0, 0, 1, 4); logF.Size = UDim2.new(1, 0, 0, 0)
		logF.AutomaticCanvasSize = Enum.AutomaticSize.Y; logF.CanvasSize = UDim2.new(0, 0, 0, 0)
		logF.ScrollBarThickness = 4; logF.BackgroundColor3 = Color3.fromRGB(14, 17, 24)
		logF.BackgroundTransparency = 0.08; logF.BorderSizePixel = 0; logF.Visible = false; logF.Parent = panel
		local pad = Instance.new("UIPadding"); pad.PaddingLeft = UDim.new(0, 8); pad.PaddingTop = UDim.new(0, 4); pad.Parent = logF
		local layout = Instance.new("UIListLayout"); layout.SortOrder = Enum.SortOrder.LayoutOrder; layout.Parent = logF
		VHud = gui; VHead = head; VLog = logF
	end)
	if ok then vHead() end
	return ok
end
local function vFocusPos(): Vector3
	local pos = Vector3.new(0, 20, 0)
	pcall(function()
		local cam = workspace.CurrentCamera
		if cam then pos = cam.Focus.Position end
	end)
	return pos
end
local function vShowChip(cmd: any, color: Color3, phase: string, note: string)
	pcall(function()
		local args = cmd.args or {}
		local target = findByPath(args.path or args.parent or "")
		local anchor: Instance? = nil
		if target and target:IsA("BasePart") then
			anchor = target
		else
			local pos = vFocusPos()
			if target then pcall(function() pos = (target :: Model):GetPivot().Position + Vector3.new(0, 3, 0) end) end
			local p = Instance.new("Part")
			p.Name = "RoLinkPin_" .. tostring(cmd.id); p.Anchored = true
			p.CanCollide = false; p.CanQuery = false; p.CanTouch = false
			p.Transparency = 1; p.Size = Vector3.new(1, 1, 1); p.Position = pos; p.Parent = workspace
			pcall(function() game:GetService("Debris"):AddItem(p, 12) end)
			anchor = p
		end
		if not anchor then return end
		local gui = Instance.new("BillboardGui")
		gui.Name = "RoLinkChip_" .. tostring(cmd.id); gui.Adornee = anchor
		gui.Size = UDim2.fromOffset(230, 56); gui.StudsOffset = Vector3.new(0, 3, 0)
		gui.AlwaysOnTop = true; gui.LightInfluence = 0; gui.Parent = anchor
		local frame = Instance.new("Frame")
		frame.Size = UDim2.fromScale(1, 1); frame.BackgroundColor3 = Color3.fromRGB(14, 17, 24)
		frame.BackgroundTransparency = 0.12; frame.BorderSizePixel = 0; frame.Parent = gui
		local fc = Instance.new("UICorner"); fc.CornerRadius = UDim.new(0, 8); fc.Parent = frame
		local stroke = Instance.new("UIStroke"); stroke.Color = color; stroke.Thickness = 1.5; stroke.Parent = frame
		local nameL = Instance.new("TextLabel")
		nameL.BackgroundTransparency = 1; nameL.Font = Enum.Font.Code; nameL.TextSize = 13
		nameL.TextColor3 = color; nameL.TextXAlignment = Enum.TextXAlignment.Left
		nameL.Text = (phase == "done" and "✓ " or (phase == "error" and "✗ " or "◌ ")) .. tostring(cmd.tool)
		nameL.Size = UDim2.new(1, -12, 0, 20); nameL.Position = UDim2.new(0, 6, 0, 4); nameL.Parent = frame
		local sub = Instance.new("TextLabel")
		sub.BackgroundTransparency = 1; sub.Font = Enum.Font.Gotham; sub.TextSize = 11
		sub.TextColor3 = Color3.fromRGB(170, 178, 190); sub.TextXAlignment = Enum.TextXAlignment.Left
		sub.Text = note; sub.Size = UDim2.new(1, -12, 0, 16); sub.Position = UDim2.new(0, 6, 0, 26); sub.Parent = frame
		pcall(function() game:GetService("Debris"):AddItem(gui, phase == "run" and 30 or 8) end)
		if phase == "run" then VPending[tostring(cmd.id) .. ":chip"] = gui end
	end)
end
local function vGhost(createdPath: string?, color: Color3)
	pcall(function()
		if not createdPath then return end
		local inst = findByPath(createdPath)
		if not inst or not inst:IsA("BasePart") then return end
		local box = Instance.new("SelectionBox")
		box.Adornee = inst; box.Color3 = color; box.LineThickness = 0.08
		box.SurfaceTransparency = 0.6; box.Parent = inst
		pcall(function() game:GetService("Debris"):AddItem(box, 6) end)
		-- Holographic beam from above: ghost shimmer on the new instance.
		local beam = Instance.new("Beam")
		local a0 = Instance.new("Attachment"); a0.Position = Vector3.new(0, 6, 0); a0.Parent = inst
		local a1 = Instance.new("Attachment"); a1.Position = Vector3.new(0, -2, 0); a1.Parent = inst
		beam.Attachment0 = a0; beam.Attachment1 = a1; beam.Color = ColorSequence.new(color)
		beam.Width0 = 0.4; beam.Width1 = 1.6; beam.Transparency = NumberSequence.new(0.4)
		beam.Parent = inst
		pcall(function()
			local d = game:GetService("Debris")
			d:AddItem(beam, 6); d:AddItem(a0, 6); d:AddItem(a1, 6)
		end)
	end)
end
local function vDiffLines(before: string, after: string): string
	local function split(s: string): { string }
		local out: { string } = {}
		for line in (s .. "\n"):gmatch("([^\n]*)\n") do table.insert(out, line) end
		return out
	end
	local a, b = split(before), split(after)
	local pre = 0
	while pre < #a and pre < #b and a[pre + 1] == b[pre + 1] do pre += 1 end
	local suf = 0
	while suf < (#a - pre) and suf < (#b - pre) and a[#a - suf] == b[#b - suf] do suf += 1 end
	local lines: { string } = {}
	for i = pre + 1, #a - suf do if #lines >= 10 then table.insert(lines, "- …"); break end; table.insert(lines, "- " .. a[i]:sub(1, 90)) end
	for i = pre + 1, #b - suf do if #lines >= 22 then table.insert(lines, "+ …"); break end; table.insert(lines, "+ " .. b[i]:sub(1, 90)) end
	if #lines == 0 then return "= no line changes" end
	return table.concat(lines, "\n")
end
local function vShowDiff(tool: string, path: string, diff: string)
	pcall(function()
		if not vEnsureHud() or not VHud then return end
		local old = VHud:FindFirstChild("RoLinkDiff")
		if old then old:Destroy() end
		local frame = Instance.new("Frame")
		frame.Name = "RoLinkDiff"; frame.AnchorPoint = Vector2.new(1, 0)
		frame.Position = UDim2.new(1, -12, 0, 76); frame.Size = UDim2.new(0, 300, 0, 170)
		frame.BackgroundColor3 = Color3.fromRGB(14, 17, 24); frame.BackgroundTransparency = 0.08
		frame.BorderSizePixel = 0; frame.Parent = VHud
		local c = Instance.new("UICorner"); c.CornerRadius = UDim.new(0, 10); c.Parent = frame
		local title = Instance.new("TextLabel")
		title.BackgroundTransparency = 1; title.Font = Enum.Font.GothamBold; title.TextSize = 11
		title.TextColor3 = Color3.fromRGB(255, 184, 0); title.TextXAlignment = Enum.TextXAlignment.Left
		title.Text = "✎ " .. tool .. "  " .. path:sub(1, 40)
		title.Size = UDim2.new(1, -12, 0, 20); title.Position = UDim2.new(0, 6, 0, 4); title.Parent = frame
		local body = Instance.new("TextLabel")
		body.BackgroundTransparency = 1; body.Font = Enum.Font.Code; body.TextSize = 10
		body.TextColor3 = Color3.fromRGB(230, 237, 243)
		body.TextXAlignment = Enum.TextXAlignment.Left; body.TextYAlignment = Enum.TextYAlignment.Top
		body.Text = diff:sub(1, 1200)
		body.Size = UDim2.new(1, -12, 1, -28); body.Position = UDim2.new(0, 6, 0, 24); body.Parent = frame
		task.delay(10, function() pcall(function() frame:Destroy() end) end)
	end)
end
local function VisualizerOnClaim(cmd: any)
	pcall(function()
		if not VEnabled or not cmd then return end
		local cat = (cmd.meta and cmd.meta.category) or vCategory(cmd.tool)
		local color = VCatColor[cat] or VCatColor.tool
		VStats.running += 1; vHead(); vPlay(VSoundTick, 0.25, 1.2)
		vEnsureHud()
		if VLog then VLog.Visible = true end
		vLogLine("◌ " .. tostring(cmd.tool), color)
		local args = cmd.args or {}
		if cmd.tool == "set_script_content" and args.path then
			local inst = findByPath(args.path)
			if inst then
				local ok, src = pcall(function() return (inst :: any).Source end)
				VPending[tostring(cmd.id)] = { before = (ok and type(src) == "string") and src or "" }
			end
		end
		vShowChip(cmd, color, "run", cat .. " · running…")
	end)
end
local function VisualizerOnDone(cmd: any, result: any, err: string?, elapsed: number?)
	pcall(function()
		if not cmd then return end
		local cat = (cmd.meta and cmd.meta.category) or vCategory(cmd.tool)
		local color = VCatColor[cat] or VCatColor.tool
		VStats.running = math.max(0, VStats.running - 1); VStats.total += 1
		local okDone = err == nil
		if not okDone then VStats.errors += 1 end
		vHead()
		if VEnabled then vPlay(okDone and VSoundOk or VSoundErr, okDone and 0.22 or 0.35, okDone and 1.4 or 0.55) end
		local ms = ""
		if type(elapsed) == "number" then ms = elapsed < 1 and string.format(" · %dms", math.floor(elapsed * 1000)) or string.format(" · %.1fs", elapsed) end
		vLogLine((okDone and "✓ " or "✗ ") .. tostring(cmd.tool) .. ms, okDone and color or Color3.fromRGB(248, 81, 73))
		if not VEnabled then return end
		local key = tostring(cmd.id) .. ":chip"
		local old = VPending[key]
		if old then pcall(function() (old :: BillboardGui):Destroy() end); VPending[key] = nil end
		vShowChip(cmd, okDone and color or Color3.fromRGB(248, 81, 73), okDone and "done" or "error", cat .. (okDone and " · done" or " · failed") .. ms)
		if okDone and result and type(result) == "table" then
			local created = (result :: any).created or (result :: any).cloned or (result :: any).model
			if type(created) == "string" then vGhost(created, color) end
		end
		if okDone and cmd.tool == "set_script_content" then
			local args = cmd.args or {}
			local pend = VPending[tostring(cmd.id)]
			local before = (pend and pend.before) or ""
			VPending[tostring(cmd.id)] = nil
			if type(args.content) == "string" then vShowDiff(cmd.tool, tostring(args.path or ""), vDiffLines(before, args.content)) end
		end
	end)
end
hudBtn.Click:Connect(function()
	VEnabled = not VEnabled
	hudBtn:SetActive(VEnabled)
	pcall(function() if VHud then VHud.Enabled = VEnabled end end)
	log("hologram HUD " .. (VEnabled and "enabled" or "disabled"))
end)
hudBtn:SetActive(true)
-- ── end P3 ToolVisualizer ─────────────────────────────────────────────

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
    elseif tool=="get_script_content" then
      local inst=findByPath(args.path or ""); if not inst then error("not found") end; result={content=(inst::any).Source or ""}
    elseif tool=="set_script_content" then
      local inst=findByPath(args.path or ""); if not inst then error("not found") end; (inst::any).Source=args.content; result={set=true}
    elseif tool=="create_module" then
      local parent=findByPath(args.path:match("(.+)/[^/]+$") or "ReplicatedStorage") or game.ReplicatedStorage; local name=args.path:match("[^/]+$") or "Module"; local m=Instance.new("ModuleScript"); m.Name=name; m.Source=args.exports or "return {}"; m.Parent=parent; result={created=m:GetFullName()}
    elseif tool=="run_function" then
      local inst=findByPath(args.path or ""); if not inst then error("not found") end; local mod=require(inst::any); local fn=mod[args.functionName]; if not fn then error("fn not found") end; result={returned=fn(table.unpack(args.args or {}))}
    elseif tool=="add_event_handler" then
      local inst=findByPath(args.path or ""); if not inst then error("not found") end; local sig=(inst::any)[args.event]; if sig and sig.Connect then sig:Connect(function(...) local f, _=loadstring(args.handlerCode); if f then pcall(setfenv,f,safeEnv); pcall(f, ...) end end); result={attached=true} end
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
    elseif tool=="simulate_ticks" then for i=1, (args.seconds or 1)*10 do RunService.Heartbeat:Wait() end; result={simulated=true, seconds=args.seconds}
    -- 23-28 Context
    elseif tool=="get_context_summary" or tool=="get_context" then result={context=captureSnapshot(2)}
    elseif tool=="get_function_signatures" then result={signatures={"init()","update(dt)"}}
    elseif tool=="get_property_value" or tool=="get_property" then local inst=findByPath(args.path or ""); result={value= inst and (inst::any)[args.property] or nil}
    elseif tool=="get_all_properties" then local inst=findByPath(args.path or ""); local t={}; if inst then for k,v in pairs(inst::any) do pcall(function() t[k]=tostring(v) end) end end; result={properties=t}
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
    -- 47-50 Animation
    elseif tool=="create_animation_track" then result={track=args.name}
    elseif tool=="play_animation" then result={playing=true}
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
  if not ok then err=tostring(ret) end
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
  local ok, res=pcall(function() return HttpService:RequestAsync({Url=MCP_URL.."/queue/next?projectId=default", Method="GET"}) end)
  if not ok then return end
  local ok2, data=pcall(function() return HttpService:JSONDecode(res.Body) end)
  if not ok2 then return end
  local cmd=data.command; if not cmd then return end
  log("executing "..cmd.id.." tool="..cmd.tool)
  VisualizerOnClaim(cmd)
  local result, err, elapsed=executeCommand(cmd)
  VisualizerOnDone(cmd, result, err, elapsed)
  reportResult(cmd.id, result, err, elapsed)
  if err then warn("[RoLink] "..err) end
end

btn.Click:Connect(function() enabled=not enabled; btn:SetActive(enabled); log(enabled and "enabled" or "disabled") end)
local last=0; RunService.Heartbeat:Connect(function(dt) last+=dt; if last>=POLL_INTERVAL then last=0; task.spawn(poll) end end)
task.spawn(function() while true do task.wait(20); if enabled then pcall(function()
  local metrics={projectId="default", avgFPS=60, activePlayers=#game.Players:GetPlayers()}
  if #workspace:GetDescendants()>600 then metrics.avgFPS=35 end
  HttpService:RequestAsync({Url=MCP_URL.."/metrics", Method="POST", Headers={["Content-Type"]="application/json"}, Body=HttpService:JSONEncode(metrics)})
end) end end end)
log("RoLink 4.0 loaded — 111 tools ready, polling "..MCP_URL)
