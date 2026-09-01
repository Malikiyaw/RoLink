window.ROLINK_PROVIDER="arena";
// Arena only Direct mode — block Start in other modes
(function(){
  const obs=new MutationObserver(()=>{
    const sel=document.querySelector('select');
    if(sel && sel.value!=="Direct") sel.value="Direct";
  });
  try{ obs.observe(document.documentElement,{childList:true,subtree:true}); }catch{}
})();
