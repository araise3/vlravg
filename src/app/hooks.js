import {useEffect,useRef,useState,useSyncExternalStore} from 'react';
import {getSnapshot,subscribe} from '@/engine/core.mjs';

// The engine's current state; re-renders on every engine change. The server
// snapshot is the same state, so components also render in tests.
export function useEngine(){
  return useSyncExternalStore(subscribe,getSnapshot,getSnapshot);
}

// Runs `effect` whenever a counter signal increases (not on mount).
export function useSignal(signal,effect){
  const seen=useRef(signal);
  useEffect(()=>{
    if(signal===seen.current)return;
    seen.current=signal;
    effect();
  },[signal]); // eslint-disable-line react-hooks/exhaustive-deps
}

// Element width, tracked with ResizeObserver (0 until measured).
export function useElementWidth(){
  const ref=useRef(null);
  const [width,setWidth]=useState(0);
  useEffect(()=>{
    const el=ref.current;
    if(!el||typeof ResizeObserver==='undefined')return;
    const update=()=>setWidth(Math.round(el.clientWidth));
    update();
    const observer=new ResizeObserver(update);
    observer.observe(el);
    return()=>observer.disconnect();
  },[]);
  return [ref,width];
}

// Current time, ticking every `ms` while `active`.
export function useNow(active,ms=1000){
  const [now,setNow]=useState(()=>Date.now());
  useEffect(()=>{
    if(!active)return;
    const timer=setInterval(()=>setNow(Date.now()),ms);
    return()=>clearInterval(timer);
  },[active,ms]);
  return now;
}

// Phones get their own layout (top bar, bottom tab bar, card lists instead of
// wide tables). Tailwind's `sm` breakpoint is 640px, so this matches max-sm.
export const MOBILE_QUERY='(max-width: 639px)';
export function useIsMobile(){
  return useMediaQuery(MOBILE_QUERY);
}

export function useMediaQuery(query){
  return useSyncExternalStore(
    callback=>{const list=matchMedia(query);list.addEventListener('change',callback);return()=>list.removeEventListener('change',callback);},
    ()=>matchMedia(query).matches,
    ()=>false,
  );
}
