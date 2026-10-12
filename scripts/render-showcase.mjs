// Optional offline film renderer. The website itself needs no build or packages.
// Requires Playwright (or --playwright-dir), Chromium and ffmpeg on PATH.
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const args=Object.fromEntries(process.argv.slice(2).map(arg=>{const [key,...rest]=arg.replace(/^--/,'').split('=');return [key,rest.join('=')||true];}));
const require=createRequire(import.meta.url);
const {chromium}=require(args['playwright-dir']?resolve(args['playwright-dir'],'playwright'):'playwright');
const output=resolve(args.output||resolve(root,'artifacts','showcase'));
await mkdir(output,{recursive:true});
const mime={'.html':'text/html; charset=utf-8','.png':'image/png','.svg':'image/svg+xml','.js':'text/javascript'};
const server=createServer(async(req,res)=>{
  try{
    const pathname=decodeURIComponent(new URL(req.url,'http://localhost').pathname);
    const path=resolve(root,'.'+pathname);
    if(!path.startsWith(root+sep)){res.writeHead(403);res.end();return;}
    const body=await readFile(path);res.writeHead(200,{'Content-Type':mime[extname(path)]||'application/octet-stream'});res.end(body);
  }catch{res.writeHead(404);res.end();}
});
server.listen(0,'127.0.0.1');await once(server,'listening');
let browser,encoder;
try{
  browser=await chromium.launch({headless:true,...(args.browser?{executablePath:args.browser}:{})});
  const page=await browser.newPage({viewport:{width:1440,height:1100},deviceScaleFactor:1});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/showcase.html`);
  await page.evaluate(async()=>{window.showcase.pause();await window.showcase.ready;});
  const duration=await page.evaluate(()=>window.showcase.duration);
  for(let i=0;i<8;i++){
    const png=await page.evaluate(time=>{window.showcase.render(time);return document.getElementById('canvas').toDataURL('image/png').split(',')[1];},i*6+3);
    await writeFile(resolve(output,`scene-${i+1}.png`),Buffer.from(png,'base64'));
  }
  // Exercise actual playback, chapter selection, seeking, replay and small layout.
  await page.getByRole('button',{name:'Find your duo',exact:false}).click();
  let position=await page.locator('#scrub').inputValue();
  if(Math.abs(Number(position)-24.65)>.1)throw Error('Chapter seek failed');
  await page.locator('#scrub').fill('14');
  await page.locator('#scrub').dispatchEvent('input');
  if(await page.locator('#time').textContent()!=='0:14 / 0:48')throw Error('Scrub failed');
  await page.locator('#play').click();await page.waitForTimeout(150);
  position=Number(await page.locator('#scrub').inputValue());
  if(position<=14)throw Error('Playback did not advance');
  await page.locator('#play').click();
  await page.locator('#replay').click();
  if(Number(await page.locator('#scrub').inputValue())>1)throw Error('Replay failed');
  await page.evaluate(()=>window.showcase.pause());
  await page.setViewportSize({width:390,height:844});
  await page.evaluate(()=>window.showcase.seek(15));
  const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);
  if(overflow)throw Error('Mobile page overflows horizontally');
  await page.screenshot({path:resolve(output,'mobile-preview.png'),fullPage:true});
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.reload();
  await page.evaluate(async()=>await window.showcase.ready);
  if(await page.locator('#play').textContent()!=='Play')throw Error('Reduced motion did not pause autoplay');
  await page.evaluate(()=>window.showcase.pause());
  if(errors.length)throw Error(errors.join('\n'));
  console.log('Verified: all 8 scenes, chapters, scrubbing, playback, replay, mobile layout and reduced motion.');
  if(args['preview-only'])process.exitCode=0;
  else{
    const fps=30,total=Math.round(duration*fps),video=resolve(output,'vlravg-showcase.mp4');
    encoder=spawn(args.ffmpeg||'ffmpeg',['-y','-hide_banner','-loglevel','error','-f','image2pipe','-framerate',String(fps),'-vcodec','png','-i','pipe:0','-an','-c:v','libx264','-preset','medium','-crf','18','-pix_fmt','yuv420p','-movflags','+faststart',video],{windowsHide:true,stdio:['pipe','ignore','pipe']});
    let diagnostic='';encoder.stderr.on('data',chunk=>diagnostic+=chunk.toString());
    const done=new Promise((resolve,reject)=>{encoder.once('error',reject);encoder.once('close',code=>code===0?resolve():reject(Error(`ffmpeg exited ${code}: ${diagnostic}`)));});
    // Attach the rejection handler immediately, including failures before stdin ends.
    done.catch(()=>{});encoder.stdin.on('error',()=>{});
    for(let frame=0;frame<total;frame+=12){
      const count=Math.min(12,total-frame);
      const batch=await page.evaluate(({frame,count,fps})=>Array.from({length:count},(_,i)=>{window.showcase.render((frame+i)/fps);return document.getElementById('canvas').toDataURL('image/png').split(',')[1];}),{frame,count,fps});
      for(const png of batch){if(!encoder.stdin.write(Buffer.from(png,'base64')))await once(encoder.stdin,'drain');}
      if(frame%180===0)console.log(`Rendering ${Math.round(frame/total*100)}%`);
    }
    encoder.stdin.end();await done;console.log(`Rendered ${duration}s at 1920×1080 / ${fps} fps: ${video}`);
  }
}finally{
  if(encoder&&encoder.exitCode===null)encoder.kill();
  if(browser)await browser.close();
  await new Promise(resolve=>server.close(resolve));
}
