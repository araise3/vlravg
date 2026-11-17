// Renders the real React components to static HTML for tests. Modules load
// through Vite's SSR loader (same aliases and JSX transform as the app), so
// a component and the engine it reads share one module instance.
import {fileURLToPath} from 'node:url';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';

const root=fileURLToPath(new URL('../..',import.meta.url));
let serverPromise=null;

async function server(){
  serverPromise??=import('vite').then(({createServer})=>createServer({
    root,
    configFile:fileURLToPath(new URL('../../vite.config.mjs',import.meta.url)),
    appType:'custom',logLevel:'error',
    server:{middlewareMode:true,hmr:false,watch:null,ws:false},
    optimizeDeps:{noDiscovery:true,include:[]},
  }));
  return serverPromise;
}

export async function load(path){
  return (await server()).ssrLoadModule(path);
}

// renderHtml('/src/app/pages/RR.jsx','ScoreMarginChart',{matches})
// React itself is CommonJS: Vite externalizes it for SSR, so the native
// import here shares the components' React instance.
export async function renderHtml(path,name,props={}){
  const mod=await load(path);
  if(!mod[name])throw new Error(`${path} has no export ${name}`);
  return renderToStaticMarkup(createElement(mod[name],props));
}

// Engine state changes notify on a microtask; let them settle before reading.
export const settle=()=>new Promise(resolve=>setTimeout(resolve,0));

export async function closeRenderer(){
  if(!serverPromise)return;
  const instance=await serverPromise;
  serverPromise=null;
  await instance.close();
}
