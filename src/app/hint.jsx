import {useState} from 'react';
import {cn} from '@/lib/utils';
import {Tooltip,TooltipContent,TooltipProvider,TooltipTrigger} from '@/components/ui/tooltip';

// An explanation on hover or keyboard focus (shadcn Tooltip), replacing the
// native `title` tooltips that never show on touch screens: a tap toggles it
// too, and a dotted underline marks the text that has one. `asChild`: the
// child is already focusable (a button) and is the trigger itself. `passive`:
// the text sits inside a button or an aria-hidden row, so it opens on hover
// only and adds no focus stop or underline.
export function Hint({content,children,asChild,passive,className,side='top'}){
  const [open,setOpen]=useState(false);
  if(content==null||content==='')return children;
  const trigger=asChild?children:(
    <span tabIndex={passive?undefined:0} data-slot="hint"
      className={cn(!passive&&'cursor-help rounded-sm underline decoration-muted-foreground/45 decoration-dotted underline-offset-[3px] outline-none focus-visible:ring-1 focus-visible:ring-ring/50',className)}
      onClick={passive?undefined:event=>{
        // Radix closes a tooltip on click; keep it, and let taps toggle it.
        event.preventDefault();
        if(event.nativeEvent?.pointerType!=='mouse')setOpen(value=>!value);
      }}>
      {children}
    </span>
  );
  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip open={open} onOpenChange={setOpen}>
        <TooltipTrigger asChild>{trigger}</TooltipTrigger>
        <TooltipContent side={side} sideOffset={4} className="max-w-64">{content}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
