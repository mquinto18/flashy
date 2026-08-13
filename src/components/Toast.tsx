import { AnimatePresence, motion } from "motion/react";

interface ToastProps {
  message: string | null;
}

export function Toast({ message }: ToastProps) {
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-6 z-50 flex justify-center">
      <AnimatePresence>
        {message && (
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 16 }}
            transition={{ duration: 0.2 }}
            className="glass-strong rounded-full px-5 py-2.5 text-sm font-medium text-foreground"
          >
            {message}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
