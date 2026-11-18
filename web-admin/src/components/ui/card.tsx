import * as React from "react"

import { cn } from "@/lib/utils"

function Card({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card"
      className={cn(
        "flex min-w-0 flex-col gap-6 rounded-2xl border bg-card py-6 text-card-foreground shadow-xs",
        className
      )}
      {...props}
    />
  )
}

export {
  Card,
}
