// RoLink core/parser.js — pure string parser, brace-aware, whitespace tolerant
const START_M = "###MCP_TOOL###";
const LUA_START_RE = /###LUA###|```lua/i;
const LUA_END_RE = /```/;
const CMD_KEY_RE = /(command|tool)/;
const DSML_RE = /<\|DSML\|>/g;

function matchBrace(s, start){
  let depth=0, inStr=false, esc=false, quote="";
  for(let i=start;i<s.length;i++){
    const c=s[i];
    if(inStr){
      if(esc) esc=false;
      else if(c==="\\") esc=true;
      else if(c===quote) inStr=false;
    } else {
      if(c==='"' || c==="'") { inStr=true; quote=c; }
      else if(c==="{") depth++;
      else if(c==="}") { depth--; if(depth===0) return i; }
    }
  }
  return -1;
}
function parseLoose(t){
  // tolerate missing quotes, raw tabs
  return JSON.parse(t.replace(/\t/g,"\\t"));
}
function salvageCutOff(s){
  // if truncated, try closing braces
  let open=(s.match(/\{/g)||[]).length, close=(s.match(/\}/g)||[]).length;
  if(open>close) s+= "}".repeat(open-close);
  try{ return JSON.parse(s); }catch{ return null; }
}
function ZSParse(text){
  text=text.replace(DSML_RE,"");
  let idx=text.indexOf(START_M);
  if(idx===-1) return null;
  let brace=text.indexOf("{",idx);
  if(brace===-1) return null;
  let end=matchBrace(text,brace);
  let chunk = end!==-1 ? text.slice(brace,end+1) : text.slice(brace);
  try{ return parseLoose(chunk); }catch{ return salvageCutOff(chunk); }
}
