"use strict";
(() => {
  const TYPE = "CLONE_ARMY_BRIDGE_V1";
  const defaults = {enabled:true,background:"",count:3,size:.78,spread:.32,sensitivity:"medium",panelPosition:null};
  let prefs = {...defaults};
  const post = (action,payload) => window.postMessage({type:TYPE,action,payload},location.origin);
  const imageOK = v => typeof v === "string" && v.startsWith("data:image/jpeg;base64,") && v.length <= 7500000;
  const sanitize = p => ({
    enabled:p.enabled !== false, background:imageOK(p.background) ? p.background : "",
    count:p.count === 5 ? 5 : 3, size:Math.min(1,Math.max(.45,Number(p.size)||.78)),
    spread:Math.min(.43,Math.max(.15,Number(p.spread)||.32)),
    sensitivity:["low","medium","high"].includes(p.sensitivity) ? p.sensitivity : "medium",
    panelPosition:Number.isFinite(p.panelPosition?.left) && Number.isFinite(p.panelPosition?.top) ? p.panelPosition : null
  });
  async function send(message) {
    if (location.protocol === "chrome-extension:") {
      const tab = await chrome.tabs.getCurrent(); message.tabId = tab?.id;
    }
    return chrome.runtime.sendMessage(message);
  }
  async function save(patch) {
    try { await chrome.storage.local.set(patch); }
    catch { post("NOTICE",{text:"Could not save settings. Check Chrome storage space."}); }
  }
  window.addEventListener("message",e => {
    if (e.source !== window || e.origin !== location.origin || e.data?.type !== TYPE) return;
    const {action,payload:p} = e.data;
    if (action === "PERSON_CONTROL" && typeof p?.enabled === "boolean") {
      send({type:"CONTROL",enabled:p.enabled}).catch(() => {});
    } else if (action === "PERSON_FRAME" && typeof p?.image === "string" && p.image.length <= 250000 && Number.isSafeInteger(p.requestId)) {
      send({type:"SEGMENT",image:p.image}).then(result => post("PERSON_RESULT",{...result,requestId:p.requestId}), () => post("PERSON_RESULT",{ok:false,requestId:p.requestId}));
    } else if (action === "SAVE_BACKGROUND" && imageOK(p?.image)) save({background:p.image});
    else if (action === "SAVE_PREFS" && p && typeof p === "object") {
      const clean = sanitize({...prefs,...p}); const patch = {};
      for (const key of ["count","size","spread","sensitivity","panelPosition"]) if (key in p) patch[key] = clean[key];
      save(patch);
    }
  });
  chrome.storage.onChanged.addListener((changes,area) => {
    if (area !== "local") return;
    for (const key of Object.keys(defaults)) if (changes[key]) prefs[key] = changes[key].newValue ?? defaults[key];
    prefs = sanitize(prefs); post("CONFIG",prefs);
  });
  chrome.runtime.onMessage.addListener(message => { if (message?.type === "TOGGLE") post("COMMAND_TOGGLE",{}); });
  window.addEventListener("pagehide",() => send({type:"CONTROL",enabled:false}).catch(()=>{}));
  chrome.storage.local.get(defaults).then(p => {prefs=sanitize(p);post("CONFIG",prefs);});
})();
