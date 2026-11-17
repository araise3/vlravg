import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import fs from 'node:fs';
import path from 'node:path';

// Files Cloudflare Pages serves as-is next to the built app. `assets/` keeps
// its URL (/assets/...), so Vite's own output goes to /_app instead.
const STATIC_FILES=['assets','legacy','_redirects','favicon.svg','pro-players.json','showcase.html','riot-probe.html'];

function copyStaticFiles(){
  return{
    name:'vlravg-copy-static',
    apply:'build',
    closeBundle(){
      for(const file of STATIC_FILES){
        if(fs.existsSync(file))fs.cpSync(file,path.join('dist',file),{recursive:true});
      }
    },
  };
}

// `npm run dev:live` forwards /api to the deployed site instead, for checking
// UI against real accounts (same public quota gate as any visitor).
const LIVE_API='https://vlravg1.pages.dev';

export default defineConfig(({mode})=>({
  plugins:[react(),tailwindcss(),copyStaticFiles()],
  resolve:{alias:{'@':path.resolve(import.meta.dirname,'src')}},
  publicDir:false,
  build:{outDir:'dist',assetsDir:'_app',emptyOutDir:true},
  // `npm run dev` serves the React app with HMR and forwards the API to a
  // local `wrangler pages dev dist` on 8788 (see .claude/launch.json).
  server:{
    port:5173,
    proxy:{'/api':mode==='live'?{target:LIVE_API,changeOrigin:true}:'http://127.0.0.1:8788'},
    // The repo also holds large research folders; never watch or scan them.
    watch:{ignored:['**/.local/**','**/.tools/**','**/.venv-*/**','**/.wrangler/**','**/artifacts/**','**/hidden-mmr-research/**','**/rea-native-los-*/**','**/reference/**','**/legacy/**','**/dist/**']},
  },
  optimizeDeps:{entries:['index.html']},
}));
