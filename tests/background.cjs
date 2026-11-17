const vm=require('node:vm'),fs=require('node:fs'),assert=require('node:assert/strict');
const hooks={},storage={};let creates=0,closes=0,exists=false,calls=0;
const chrome={runtime:{id:'test',getURL:p=>'chrome-extension://test/'+p,getContexts:async()=>exists?[{}]:[],onMessage:{addListener:f=>hooks.message=f},sendMessage:async()=>{calls++;return{ok:true,width:1,height:1,mask:'/w=='};}},storage:{session:{get:async d=>({...d,...storage}),set:async p=>Object.assign(storage,p)}},offscreen:{createDocument:async()=>{exists=true;creates++;},closeDocument:async()=>{exists=false;closes++;}},tabs:{onRemoved:{addListener:f=>hooks.removed=f},onUpdated:{addListener:f=>hooks.updated=f},query:async()=>[],sendMessage:async()=>{}},commands:{onCommand:{addListener:f=>hooks.command=f}}};
vm.runInNewContext(fs.readFileSync('extension/background.js','utf8'),{chrome,console});
const sender=id=>({id:'test',tab:{id,url:'https://meet.google.com/abc'},url:'https://meet.google.com/abc'});
function message(data,s=sender(1)){return new Promise(resolve=>{if(!hooks.message(data,s,resolve))resolve('ignored');});}
(async()=>{
 assert.equal(await message({type:'CONTROL',enabled:true},{...sender(1),id:'other'}),'ignored');
 assert.equal(await message({type:'CONTROL',enabled:true},{...sender(1),url:'https://evil.example/'}),'ignored');
 assert.equal((await message({type:'SEGMENT',image:'data:image/jpeg;base64,AA=='})).ok,false);
 await message({type:'CONTROL',enabled:true});assert.equal((await message({type:'SEGMENT',image:'data:image/jpeg;base64,AA=='})).ok,true);assert.equal(creates,1);assert.equal(calls,1);
 await message({type:'CONTROL',enabled:true},sender(2));await message({type:'CONTROL',enabled:false});assert.equal(closes,0);
 await message({type:'CONTROL',enabled:false},sender(2));assert.equal(closes,1);
 const studio={id:'test',url:'chrome-extension://test/studio.html'};
 await message({type:'CONTROL',enabled:true,tabId:7},studio);assert.equal((await message({type:'SEGMENT',image:'data:image/jpeg;base64,AA==',tabId:7},studio)).ok,true);
 assert.equal((await message({type:'SEGMENT',image:'https://evil.example/',tabId:7},studio)).ok,false);
 await hooks.removed(7);assert.equal((await message({type:'SEGMENT',image:'data:image/jpeg;base64,AA==',tabId:7},studio)).ok,false);
 console.log('PASS background: origin checks, ownership, shared model lifetime, studio routing, invalid frames, tab cleanup');
})().catch(e=>{console.error(e);process.exitCode=1;});
