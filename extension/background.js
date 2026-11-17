"use strict";
const OWNER_KEY = "cloneArmyOwners";
let queue = Promise.resolve();
const serialized = task => (queue = queue.catch(()=>{}).then(task));
const owners = async () => new Set((await chrome.storage.session.get({[OWNER_KEY]:[]}))[OWNER_KEY]);
const allowed = url => typeof url === "string" && (url.startsWith("https://meet.google.com/") || url === chrome.runtime.getURL("studio.html"));
async function release(tabId) {
  const set = await owners(); set.delete(tabId);
  await chrome.storage.session.set({[OWNER_KEY]:[...set]});
  if (!set.size) { try { await chrome.offscreen.closeDocument(); } catch {} }
}
async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({contextTypes:["OFFSCREEN_DOCUMENT"],documentUrls:[chrome.runtime.getURL("segmenter.html")]});
  if (!contexts.length) await chrome.offscreen.createDocument({url:"segmenter.html",reasons:["BLOBS"],justification:"Decode temporary camera samples for local person cutouts. No uploads."});
}
chrome.tabs.onRemoved.addListener(tabId => serialized(()=>release(tabId)).catch(()=>{}));
chrome.tabs.onUpdated.addListener((tabId,change) => {if (change.url && !allowed(change.url)) serialized(()=>release(tabId)).catch(()=>{});});
chrome.runtime.onMessage.addListener((m,sender,reply) => {
  const tabId = sender.tab?.id ?? (sender.url === chrome.runtime.getURL("studio.html") ? m?.tabId : null);
  if (sender.id !== chrome.runtime.id || !Number.isInteger(tabId) || !allowed(sender.url || sender.tab?.url)) return false;
  if (m?.type === "CONTROL" && typeof m.enabled === "boolean") {
    serialized(async () => {
      if (!m.enabled) return release(tabId);
      const set = await owners(); set.add(tabId); await chrome.storage.session.set({[OWNER_KEY]:[...set]});
    }).then(()=>reply({ok:true}),()=>reply({ok:false})); return true;
  }
  if (m?.type !== "SEGMENT") return false;
  if (typeof m.image !== "string" || m.image.length > 250000 || !/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(m.image)) {reply({ok:false});return false;}
  serialized(async () => {
    if (!(await owners()).has(tabId)) return {ok:false};
    await ensureOffscreen();
    return chrome.runtime.sendMessage({target:"CLONE_ARMY_MODEL",image:m.image});
  }).then(reply,()=>reply({ok:false})); return true;
});
chrome.commands.onCommand.addListener(async command => {
  if (command !== "toggle-army") return;
  const [tab] = await chrome.tabs.query({active:true,lastFocusedWindow:true});
  if (!tab?.id || !allowed(tab.url)) return;
  try { await chrome.tabs.sendMessage(tab.id,{type:"TOGGLE"}); } catch {}
});
