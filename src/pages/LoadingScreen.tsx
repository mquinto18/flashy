import { motion } from "motion/react";
import logo from "../assets/flashy-logo.png";

export function LoadingScreen() {
  return (
    <div className="flex min-h-svh flex-col items-center justify-center gap-4 bg-background">
      <motion.img
        src={logo}
        alt="Flashy logo"
        width={48}
        height={48}
        className="size-12 drop-shadow-[0_0_18px_oklch(0.85_0.13_195/0.5)]"
        animate={{ scale: [1, 1.08, 1] }}
        transition={{ repeat: Infinity, duration: 1.4, ease: "easeInOut" }}
      />
      <p className="text-sm text-muted-foreground">Loading Flashy…</p>
    </div>
  );
}
