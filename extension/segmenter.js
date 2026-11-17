import { FilesetResolver, ImageSegmenter } from "./vendor/vision_bundle.mjs";
let modelPromise;
async function segment(image) {
  let bitmap,result;
  try {
    if (typeof image !== "string" || image.length > 250000 || !/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(image)) throw new Error("Invalid frame");
    if (!modelPromise) modelPromise = (async () => {
      const files = await FilesetResolver.forVisionTasks(chrome.runtime.getURL("vendor/wasm"));
      return ImageSegmenter.createFromOptions(files,{baseOptions:{modelAssetPath:chrome.runtime.getURL("models/selfie_segmenter.tflite"),delegate:"CPU"},runningMode:"IMAGE",outputCategoryMask:false,outputConfidenceMasks:true});
    })().catch(e=>{modelPromise=null;throw e;});
    const model = await modelPromise;
    const bytes = Uint8Array.from(atob(image.split(",")[1]),c=>c.charCodeAt(0));
    bitmap = await createImageBitmap(new Blob([bytes],{type:"image/jpeg"}));
    if (bitmap.width > 512 || bitmap.height > 512) throw new Error("Oversized frame");
    result = model.segment(bitmap);
    const confidence = result.confidenceMasks?.[1] || result.confidenceMasks?.[0];
    if (!confidence) throw new Error("No person mask");
    const values = confidence.getAsFloat32Array(), mask = new Uint8Array(values.length);
    for (let i=0;i<mask.length;i++) {
      const x = Math.max(0,Math.min(1,(values[i]-.2)/.6));
      mask[i] = Math.round(x*x*(3-2*x)*255);
    }
    let encoded="";
    for (let i=0;i<mask.length;i+=8192) encoded+=String.fromCharCode(...mask.subarray(i,i+8192));
    return {ok:true,width:confidence.width,height:confidence.height,mask:btoa(encoded)};
  } catch (e) {console.warn("[Clone Army] Segmentation unavailable",e);return {ok:false};}
  finally {result?.close();bitmap?.close();}
}
chrome.runtime.onMessage.addListener((m,sender,reply)=>{
  if (sender.id !== chrome.runtime.id || m?.target !== "CLONE_ARMY_MODEL") return false;
  segment(m.image).then(reply);return true;
});
