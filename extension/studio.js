"use strict";
const preview = document.querySelector("#preview");
const start = document.querySelector("#start"), stop = document.querySelector("#stop");
let stream = null, pending = false, generation = 0;
start.addEventListener("click",async()=>{
  if (pending || stream) return;
  pending = true;start.disabled = true;const current = ++generation;
  try {
    const result = await navigator.mediaDevices.getUserMedia({video:{width:{ideal:1280},height:{ideal:720}},audio:false});
    if (current !== generation) {result.getTracks().forEach(t=>t.stop());return;}
    stream = result;preview.srcObject = stream;await preview.play();
    document.querySelector("#placeholder").hidden=true;stop.hidden=false;
    document.querySelector("#camera-status").textContent="LIVE · PRIVATE PREVIEW";
    document.querySelector("#studio-message").textContent="Capture your empty room using the panel on the right.";
  } catch(e) { document.querySelector("#studio-message").textContent="Camera unavailable. Allow camera access in Chrome, then try again."; }
  finally {pending=false;start.disabled=false;}
});
function stopCamera(){generation++;stream?.getTracks().forEach(t=>t.stop());stream=null;preview.srcObject=null;stop.hidden=true;document.querySelector("#placeholder").hidden=false;document.querySelector("#camera-status").textContent="CAMERA OFF";document.querySelector("#studio-message").textContent="Camera stopped.";}
stop.addEventListener("click",stopCamera);
window.addEventListener("pagehide",stopCamera);
window.addEventListener("keydown", e => {if(e.altKey&&e.shiftKey&&e.code==="KeyC"){e.preventDefault();window.postMessage({type:"CLONE_ARMY_BRIDGE_V1",action:"COMMAND_TOGGLE"},location.origin);}});
