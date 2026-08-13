import type { MouseEvent } from "react";
import { motion, AnimatePresence } from "motion/react";
import { Check, Loader2, Play, Rocket, X } from "lucide-react";

type LaunchStatus = "launching" | "success" | "error";

interface LaunchButtonProps {
  onClick: () => void;
  status?: LaunchStatus;
  label?: string;
  variant?: "icon" | "primary";
}

const statusStyles: Record<LaunchStatus, string> = {
  launching: "bg-secondary/60 text-primary",
  success: "bg-primary/20 text-primary",
  error: "bg-destructive/20 text-destructive",
};

function StatusIcon({ status }: { status: LaunchStatus }) {
  if (status === "launching") return <Loader2 className="size-4 animate-spin" />;
  if (status === "success") return <Check className="size-4" />;
  return <X className="size-4" />;
}

export function LaunchButton({ onClick, status, label, variant = "icon" }: LaunchButtonProps) {
  function handleClick(e: MouseEvent) {
    e.stopPropagation();
    onClick();
  }

  if (variant === "primary") {
    const launching = status === "launching";
    return (
      <motion.button
        type="button"
        onClick={handleClick}
        whileHover={{ scale: 1.015 }}
        whileTap={{ scale: 0.99 }}
        className={`bg-brand-gradient flex items-center justify-center gap-2 rounded-full py-3.5 text-sm font-semibold text-primary-foreground transition-transform duration-300 ${
          launching ? "animate-pulse-ring" : ""
        }`}
      >
        <Rocket className={`size-4 ${launching ? "animate-bounce" : ""}`} />
        {label}
      </motion.button>
    );
  }

  return (
    <motion.button
      type="button"
      onClick={handleClick}
      whileHover={{ scale: 1.08 }}
      whileTap={{ scale: 0.92 }}
      className={`grid size-8 shrink-0 place-items-center rounded-full transition-colors ${
        status ? statusStyles[status] : "text-muted-foreground hover:bg-secondary/60 hover:text-primary"
      }`}
    >
      <AnimatePresence mode="wait" initial={false}>
        <motion.span
          key={status ?? "idle"}
          initial={{ opacity: 0, scale: 0.6 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.6 }}
          transition={{ duration: 0.15 }}
          className="inline-flex"
        >
          {status ? <StatusIcon status={status} /> : <Play className="size-3.5 fill-current" />}
        </motion.span>
      </AnimatePresence>
    </motion.button>
  );
}
