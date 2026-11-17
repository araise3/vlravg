import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import {initEngine} from '@/engine/core.mjs';
import App from '@/app/App.jsx';
import './index.css';

async function start(){
  let fixture=null;
  // Local-only synthetic data (?fixture=demo|worst|draws|malformed|one|climb|empty|loading|error|<n>).
  const fixtureCase=new URLSearchParams(location.search).get('fixture');
  if(import.meta.env.DEV&&fixtureCase){
    const {loadFixture}=await import('@/dev/fixtures.mjs');
    fixture=()=>loadFixture(fixtureCase);
  }
  createRoot(document.getElementById('root')).render(<StrictMode><App/></StrictMode>);
  initEngine({fixture});
}

start();
