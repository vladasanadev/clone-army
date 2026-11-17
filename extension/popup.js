"use strict";
const enabled = document.querySelector("#enabled"), notice = document.querySelector("#notice");
chrome.storage.local.get({enabled:true}).then(p=>enabled.checked=p.enabled!==false);
enabled.addEventListener("change",async()=>{
  try{await chrome.storage.local.set({enabled:enabled.checked});notice.textContent=enabled.checked?"Enabled. Reload Meet if controls are missing.":"Effect disabled. Reconnect your camera for the direct feed.";}
  catch{notice.textContent="Could not save. Try again.";enabled.checked=!enabled.checked;}
});
document.querySelector("#studio").addEventListener("click",()=>chrome.tabs.create({url:chrome.runtime.getURL("studio.html")}));
