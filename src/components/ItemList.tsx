import { AnimatePresence, motion } from "motion/react";
import type { WorkspaceItem } from "../types/workspace";
import { ItemRow } from "./ItemRow";

type LaunchStatus = "launching" | "success" | "error";

interface ItemListProps {
  items: WorkspaceItem[];
  feedback: Record<string, LaunchStatus>;
  runningApps: Record<string, boolean>;
  isLaunchingAll: boolean;
  onRemove: (id: string) => void;
  onLaunch: (item: WorkspaceItem) => void;
}

export function ItemList({ items, feedback, runningApps, isLaunchingAll, onRemove, onLaunch }: ItemListProps) {
  if (items.length === 0) {
    return (
      <p className="px-3 py-8 text-center text-sm text-muted-foreground">
        Nothing here yet — drop an app, link, file or folder to fill this workspace.
      </p>
    );
  }

  return (
    <motion.ul
      className="flex min-w-0 max-h-64 flex-col gap-2 overflow-y-auto pr-1"
      initial="hidden"
      animate="visible"
      variants={{ visible: { transition: { staggerChildren: 0.05 } } }}
    >
      <AnimatePresence initial={false}>
        {items.map((item, index) => (
          <ItemRow
            key={item.id}
            item={item}
            index={index}
            status={feedback[item.id]}
            isLaunchingAll={isLaunchingAll}
            isRunning={runningApps[item.id]}
            onLaunch={() => onLaunch(item)}
            onRemove={() => onRemove(item.id)}
          />
        ))}
      </AnimatePresence>
    </motion.ul>
  );
}
