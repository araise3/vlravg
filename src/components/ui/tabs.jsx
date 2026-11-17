import * as React from "react"
import { Tabs as TabsPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"

// Layout effects only run in the browser; SSR (tests) falls back to useEffect.
const useIsoLayoutEffect = typeof window === "undefined" ? React.useEffect : React.useLayoutEffect

function Tabs({
  className,
  ...props
}) {
  return (
    <TabsPrimitive.Root
      data-slot="tabs"
      className={cn("flex flex-col gap-2", className)}
      {...props}
    />
  )
}

const BOX_KEYS = ["left", "top", "width", "height"]

// Next indicator box from the active trigger's measurement: a box, null (no
// active trigger) or "hidden" (the list is not rendered, e.g. on a page kept
// mounted behind `hidden`). Hidden lists keep their last box instead of
// collapsing to 0×0, and the first box after being hidden, or ever, snaps
// (`snap: true`) so the indicator never slides in from the corner.
function nextIndicatorBox(previous, measured) {
  if (measured === "hidden") return previous && !previous.hidden ? { ...previous, hidden: true } : previous
  if (!measured) return null
  if (previous && !previous.hidden && BOX_KEYS.every((key) => previous[key] === measured[key])) return previous
  const next = { snap: !previous || Boolean(previous.hidden) }
  for (const key of BOX_KEYS) next[key] = measured[key]
  return next
}

// Measures the active trigger inside `listRef` and returns the indicator's
// box. It follows value changes (data-state), label changes and wrapping.
function useActiveTriggerBox(listRef) {
  const [box, setBox] = React.useState(null)

  useIsoLayoutEffect(() => {
    const list = listRef.current
    if (!list) return undefined
    const measure = () => {
      const active = list.querySelector('[data-slot="tabs-trigger"][data-state="active"]')
      const measured = !list.getClientRects().length ? "hidden" : active && {
        left: active.offsetLeft,
        top: active.offsetTop,
        width: active.offsetWidth,
        height: active.offsetHeight,
      }
      setBox((previous) => nextIndicatorBox(previous, measured))
    }
    measure()
    const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure)
    const observeTriggers = () => {
      if (!resize) return
      resize.disconnect()
      resize.observe(list)
      list.querySelectorAll('[data-slot="tabs-trigger"]').forEach((trigger) => resize.observe(trigger))
    }
    observeTriggers()
    const mutations = new MutationObserver((records) => {
      if (records.some((record) => record.type === "childList")) observeTriggers()
      measure()
    })
    mutations.observe(list, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-state"] })
    return () => {
      resize?.disconnect()
      mutations.disconnect()
    }
  }, [listRef])

  return box
}

function TabsList({
  className,
  children,
  ref,
  ...props
}) {
  const listRef = React.useRef(null)
  const setRefs = React.useCallback((node) => {
    listRef.current = node
    if (typeof ref === "function") ref(node)
    else if (ref) ref.current = node
  }, [ref])
  const box = useActiveTriggerBox(listRef)

  return (
    <TabsPrimitive.List
      ref={setRefs}
      data-slot="tabs-list"
      className={cn(
        "relative isolate inline-flex h-9 w-fit items-center justify-center rounded-lg bg-muted p-[3px] text-muted-foreground",
        className
      )}
      {...props}
    >
      <span
        aria-hidden="true"
        data-slot="tabs-indicator"
        className={cn(
          "pointer-events-none absolute top-0 left-0 -z-10 rounded-md border border-transparent bg-background shadow-sm dark:border-input dark:bg-input/30",
          box && !box.snap && "transition-[transform,width,height] duration-200 ease-out motion-reduce:transition-none",
          !box && "opacity-0"
        )}
        style={box ? {
          width: box.width,
          height: box.height,
          transform: `translate(${box.left}px, ${box.top}px)`,
        } : undefined}
      />
      {children}
    </TabsPrimitive.List>
  )
}

function TabsTrigger({
  className,
  ...props
}) {
  return (
    <TabsPrimitive.Trigger
      data-slot="tabs-trigger"
      className={cn(
        "inline-flex h-[calc(100%-1px)] flex-1 items-center justify-center gap-1.5 rounded-md border border-transparent px-2 py-1 text-sm font-medium whitespace-nowrap text-foreground transition-[color,border-color,box-shadow] duration-200 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-1 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-50 dark:text-muted-foreground dark:hover:text-foreground dark:data-[state=active]:text-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className
      )}
      {...props}
    />
  )
}

function TabsContent({
  className,
  ...props
}) {
  return (
    <TabsPrimitive.Content
      data-slot="tabs-content"
      className={cn("flex-1 outline-none data-[state=active]:animate-in data-[state=active]:fade-in-0 data-[state=active]:duration-200 motion-reduce:animate-none", className)}
      {...props}
    />
  )
}

export { Tabs, TabsList, TabsTrigger, TabsContent, nextIndicatorBox }
