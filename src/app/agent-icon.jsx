import {useEffect,useState} from 'react';
import {loadAgentMetadata} from '@/engine/core.mjs';
import {cn} from '@/lib/utils';

// Agent icons and colours from valorant-api.com (loadAgentMetadata), loaded
// once per page. Optional: until they arrive, or when the API is unreachable,
// the tile shows the agent's initial on a neutral background.
export function useAgentArt(){
  const [agents,setAgents]=useState(null);
  useEffect(()=>{let live=true;loadAgentMetadata().then(result=>{if(live)setAgents(result);});return()=>{live=false;};},[]);
  return agents;
}

// The agent's colour lifted for text and bars on the dark theme (the raw
// gradient colours are dark tints meant for backgrounds). Null without art.
export function agentTint(agents,name,id){
  const art=agents?.get(String(id||'').toLowerCase())||agents?.get(String(name||'').toLowerCase());
  return art?.color?`color-mix(in oklab, ${art.color} 50%, white)`:null;
}

// A square tile in the agent's colour with their icon. Decorative: the
// agent's name is always written next to it.
export function AgentIcon({agents,name,id,size=24,className}){
  const art=agents?.get(String(id||'').toLowerCase())||agents?.get(String(name||'').toLowerCase())||null;
  return (
    <span aria-hidden="true" data-slot="agent-icon" data-agent={name||undefined}
      className={cn('inline-flex shrink-0 items-center justify-center overflow-hidden rounded-md text-[10px] font-semibold text-white/80',!art?.color&&'bg-muted',className)}
      style={{width:size,height:size,background:art?.color||undefined,boxShadow:art?.color?`inset 0 0 0 1px color-mix(in oklab, ${art.color} 60%, white 25%)`:undefined}}>
      {art?.icon
        ?<img src={art.icon} alt="" width={size} height={size} loading="lazy" decoding="async" className="size-full object-cover"/>
        :(name||'').slice(0,1)}
    </span>
  );
}
