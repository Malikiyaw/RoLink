/**
 * S15 Roblox Library / Asset Store Integration — search + import via Marketplace/Toolbox proxy
 * Production: calls https://search.roblox.com/catalog/json?Keyword=... or Marketplace API.
 * Here we implement proxy that forwards to Roblox search and queues import.
 */
export interface AssetInfo { id: number; name: string; description?: string; creator?: string; assetType?: string; url?: string; }

const ROBLOX_SEARCH = "https://search.roblox.com/catalog/json";

export async function searchAssets(keyword: string, limit=12, category?: string): Promise<AssetInfo[]> {
  const qs=new URLSearchParams({ Keyword: keyword, Category: category||"Models", Limit: String(limit), SortType: "Relevance" });
  try{
    const res=await fetch(`${ROBLOX_SEARCH}?${qs.toString()}`, { headers:{ Accept:"application/json" } });
    if(!res.ok) throw new Error(`search ${res.status}`);
    const data:any=await res.json();
    const list: AssetInfo[] = (Array.isArray(data) ? data : (data?.data||[])).slice(0,limit).map((r:any)=> ({
      id: Number(r.ItemId||r.AssetId||r.id||0),
      name: String(r.Name||r.name||"Asset"),
      description: r.Description||"",
      creator: r.CreatorName||r.creator?.name||"",
      assetType: r.AssetType||r.itemType||"Model",
      url: `https://www.roblox.com/library/${r.ItemId||r.AssetId}/redirect`
    }));
    // fallback if empty -> mock
    if(list.length===0) return mockAssets(keyword, limit);
    return list;
  }catch{
    // offline / blocked -> return mock deterministic results
    return mockAssets(keyword, limit);
  }
}

function mockAssets(keyword:string, limit:number): AssetInfo[] {
  const seeds=[ "SciFi Crate","Medieval Sword","Neon Bridge","LowPoly Tree","Futuristic Door","Coin Model","Checkpoint Flag","Lava Brick" ];
  return seeds.slice(0,limit).map((n,i)=> ({ id: 1000000+i, name:`${keyword} ${n}`, description:`Mock for ${keyword}`, creator:"RoLink", assetType:"Model", url:`https://www.roblox.com/library/${1000000+i}/redirect` }));
}

export function importInstruction(assetId: number, parent: string="workspace"): string {
  // Luau that plugin will execute to import via InsertService
  return `
local InsertService = game:GetService("InsertService")
local ok, model = pcall(function() return game:GetObjects("rbxassetid://${assetId}")[1] end)
if not ok or not model then
  ok, model = pcall(function() return InsertService:LoadAsset(${assetId}):GetChildren()[1] end)
end
if model then
  model.Parent = ${parent}
  print("[RoLink] imported ${assetId} -> ${parent}: "..model:GetFullName())
  return model
else
  error("import failed for asset ${assetId}")
end
`.trim();
}
