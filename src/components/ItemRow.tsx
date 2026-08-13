import { motion } from "motion/react";
import { Trash2 } from "lucide-react";
import type { WorkspaceItem } from "../types/workspace";
import { itemSubtext, itemTypeIcon, itemTypeLabel } from "../lib/itemDisplay";
import { LaunchButton } from "./LaunchButton";

type LaunchStatus = "launching" | "success" | "error";

interface ItemRowProps {
  item: WorkspaceItem;
  index: number;
  status?: LaunchStatus;
  isLaunchingAll: boolean;
  isRunning?: boolean;
  onLaunch: () => void;
  onRemove: () => void;
}

export function ItemRow({ item, index, status, isLaunchingAll, isRunning, onLaunch, onRemove }: ItemRowProps) {
  const Icon = itemTypeIcon[item.type];

  return (
    <motion.li
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, x: -12 }}
      transition={{ duration: 0.15 }}
      style={
        isLaunchingAll
          ? { animation: `island-drop 0.4s cubic-bezier(0.2,0.9,0.2,1) ${index * 70}ms both` }
          : undefined
      }
      className="glass group flex min-w-0 items-center gap-3 rounded-2xl px-3 py-2.5 transition-all duration-300 hover:-translate-y-0.5 hover:border-primary/40"
    >
      <span className="relative grid size-9 shrink-0 place-items-center rounded-xl border border-border bg-secondary/40">
        <Icon className="size-4 text-primary" />
        {isRunning && (
          <span className="absolute -right-0.5 -top-0.5 size-2.5 rounded-full border-2 border-card bg-emerald-500" />
        )}
      </span>
      <span className="min-w-0 flex-1 text-left">
        <span className="block truncate text-sm font-semibold text-foreground">{item.name}</span>
        <span className="block truncate text-xs text-muted-foreground">{itemSubtext(item)}</span>
      </span>
      <span
        className={`hidden rounded-full border px-2 py-0.5 text-[10px] tracking-wide sm:block ${
          isRunning ? "border-emerald-500/40 text-emerald-500" : "border-border text-muted-foreground"
        }`}
      >
        {isRunning ? "Running" : itemTypeLabel[item.type]}
      </span>
      <LaunchButton onClick={onLaunch} status={status} />
      <button
        type="button"
        onClick={onRemove}
        className="rounded-lg p-1.5 text-muted-foreground opacity-0 transition-all hover:bg-destructive/20 hover:text-foreground group-hover:opacity-100"
        aria-label={`Remove ${item.name}`}
      >
        <Trash2 className="size-4" />
      </button>
    </motion.li>
  );
}
