const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const path=require('node:path'),fs=require('node:fs'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),ext=path.join(root,'extension');
const artifacts=process.env.CLONE_TEST_OUTPUT||path.join(root,'test-results');fs.mkdirSync(artifacts,{recursive:true});
(async()=>{
 const context=await chromium.launchPersistentContext('',{channel:'chromium',executablePath:process.env.CHROME_EXECUTABLE,headless:true,args:[`--disable-extensions-except=${ext}`,`--load-extension=${ext}`,'--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream'],viewport:{width:1440,height:1100}});
 try{
 let[worker]=context.serviceWorkers();if(!worker)worker=await context.waitForEvent('serviceworker');
 const id=new URL(worker.url()).host,page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 page.on('console',m=>{if(m.type()==='error'||m.type()==='warning')console.log('BROWSER',m.text().slice(0,300));});
 await page.goto(`chrome-extension://${id}/studio.html`);await page.screenshot({path:path.join(artifacts,'studio.png'),fullPage:true});
 await page.getByRole('button',{name:'Enable camera'}).click();await page.waitForFunction(()=>document.querySelector('#preview').videoWidth>0);
 assert.equal(await page.locator('#camera-status').textContent(),'LIVE · PRIVATE PREVIEW');
 await page.getByRole('button',{name:'Capture empty room',exact:true}).click();
 await page.waitForFunction(()=>!document.querySelector('#clone-army-panel').shadowRoot.querySelector('#toggle').disabled,{},{timeout:10000});
 await page.getByRole('button',{name:'Summon clones',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('#clone-army-panel').shadowRoot.querySelector('#status-label').textContent.includes('Moving together'),{},{timeout:60000});
 console.log('PASS installed extension: camera, countdown, capture, bridge, offscreen WASM model, summon');
 await page.getByLabel('Army size',{exact:true}).selectOption('5');
 await page.waitForFunction(()=>document.querySelector('#clone-army-panel').shadowRoot.querySelector('#status-label').textContent.includes('5 of you'));
 await page.getByRole('button',{name:'Dismiss clones',exact:true}).click();
 assert.equal(await page.locator('#clone-army-panel').locator('#status-label').textContent(),'Just you');
 await page.getByRole('button',{name:'Stop camera',exact:true}).click();assert.equal(await page.locator('#camera-status').textContent(),'CAMERA OFF');
 console.log('PASS installed extension: five-person mode, dismissal, camera stop');
 const rendered=await page.evaluate(()=>{
 const w=600,h=360,c=document.createElement('canvas');c.width=w;c.height=h;const cx=c.getContext('2d');
 const bg=document.createElement('canvas');bg.width=w;bg.height=h;const bx=bg.getContext('2d');bx.fillStyle='#163d2c';bx.fillRect(0,0,w,h);
 const frame=document.createElement('canvas');frame.width=w;frame.height=h;const fx=frame.getContext('2d');fx.fillStyle='#e23040';fx.fillRect(260,100,80,260);
 const a=new Uint8Array(w*h);for(let y=100;y<h;y++)for(let x=260;x<340;x++)a[y*w+x]=255;
 const r=new CloneArmyRenderer.Renderer(w,h);r.update(frame,{width:w,height:h,mask:a});r.render(cx,bg,{count:3,size:.78,spread:.32},1);
 const countRuns=()=>{const data=cx.getImageData(0,300,w,1).data;let n=0,on=false;for(let x=0;x<w;x++){const yes=data[x*4]>150&&data[x*4+1]<80;if(yes&&!on)n++;on=yes;}return n;};
 const runs3=countRuns(),corner=Array.from(cx.getImageData(0,0,1,1).data);r.render(cx,bg,{count:5,size:.60,spread:.40},1);const runs5=countRuns();
 fx.fillStyle='#3060e0';fx.fillRect(260,100,80,260);r.update(frame,{width:w,height:h,mask:a});r.render(cx,bg,{count:3,size:.78,spread:.32},1);const live=Array.from(cx.getImageData(300,300,1,1).data);r.dispose();return{runs3,runs5,corner,live};
 });
 assert.equal(rendered.runs3,3);assert.equal(rendered.runs5,5);assert.deepEqual(rendered.corner,[22,61,44,255]);assert.deepEqual(rendered.live,[48,96,224,255]);
 console.log('PASS Canvas pixels: 3/5 distinct cutouts, untouched room, updated live frame');
 await context.route('https://meet.google.com/clone-army-test',route=>route.fulfill({status:200,contentType:'text/html',headers:{'Content-Security-Policy':"require-trusted-types-for 'script'"},body:'<!doctype html><html><head><title>Local Meet fixture</title></head><body><video id="out" autoplay muted playsinline></video></body></html>'}));
 const meet=await context.newPage();meet.on('pageerror',e=>errors.push(e.message));await meet.goto('https://meet.google.com/clone-army-test');await meet.waitForSelector('#clone-army-panel');
 const label=await meet.evaluate(async()=>{window.testStream=await navigator.mediaDevices.getUserMedia({video:true,audio:true});document.querySelector('#out').srcObject=window.testStream;return typeof window.testStream.getVideoTracks()[0].requestFrame;});assert.equal(label,'function');
 await meet.getByRole('button',{name:'Summon clones',exact:true}).click();await meet.waitForFunction(()=>document.querySelector('#clone-army-panel').shadowRoot.querySelector('#status-label').textContent.includes('Moving together'),{},{timeout:60000});
 await meet.evaluate(()=>window.testStream.getTracks().forEach(t=>t.stop()));
 console.log('PASS Meet-origin fixture: early interception, Trusted Types UI, model bridge, canvas outgoing track');
 assert.deepEqual(errors,[]);fs.writeFileSync(path.join(artifacts,'browser-report.json'),JSON.stringify({passed:true,rendered,errors,note:'Fake camera + intercepted Meet fixture; not a live call.'},null,2));
 }finally{await context.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
