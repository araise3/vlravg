"use client"

import * as React from "react"
import { cn } from "@/lib/utils"
import { Progress as ProgressPrimitive } from "radix-ui"

// Repo additions: `value` is forwarded to Radix (aria-valuenow), a null value
// is indeterminate (a segment sliding across, as Radix's own null means), and
// `indicatorClassName` styles the bar.
function Progress({
  className,
  value,
  indicatorClassName,
  ...props
}) {
  const indeterminate = value == null
  return (
    <ProgressPrimitive.Root
      data-slot="progress"
      value={indeterminate ? null : value}
      className={cn(
        "relative h-2 w-full overflow-hidden rounded-full bg-primary/20",
        className
      )}
      {...props}
    >
      <ProgressPrimitive.Indicator
        data-slot="progress-indicator"
        className={cn(
          "h-full w-full flex-1 bg-primary",
          indeterminate
            ? "w-[35%] animate-[progress-indeterminate_1.5s_ease-in-out_infinite] motion-reduce:animate-none"
            : "transition-all",
          indicatorClassName
        )}
        style={indeterminate ? undefined : { transform: `translateX(-${100 - (value || 0)}%)` }}
      />
    </ProgressPrimitive.Root>
  )
}

export { Progress }
