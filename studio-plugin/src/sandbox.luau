-- sandbox.luau — allowlist env for safe execution, used by init.plugin.luau
local M = {}
M.safeEnv = {
	print = print, warn = warn, error = error,
	pairs = pairs, ipairs = ipairs, type = type,
	math = math, string = string, table = table,
	game = game, workspace = workspace, Instance = Instance, Enum = Enum, task = task,
}
function M.run(code: string)
	local fn, err = loadstring(code)
	if not fn then return false, err end
	pcall(function() setfenv(fn, M.safeEnv) end)
	return pcall(fn)
end
return M
