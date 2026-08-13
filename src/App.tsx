import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useWorkspaceStore } from "./store/useWorkspaceStore";
import { useToastStore } from "./store/useToastStore";
import { LoadingScreen } from "./pages/LoadingScreen";
import { StartScreen } from "./pages/StartScreen";
import { AppScreen } from "./pages/AppScreen";
import { Toast } from "./components/Toast";
import bg from "./assets/desk-bg.jpg";

function App() {
  const isLoaded = useWorkspaceStore((s) => s.isLoaded);
  const loadWorkspaces = useWorkspaceStore((s) => s.loadWorkspaces);
  const toastMessage = useToastStore((s) => s.message);
  const [screen, setScreen] = useState<"start" | "app">("start");

  useEffect(() => {
    void loadWorkspaces();
  }, [loadWorkspaces]);

  if (!isLoaded) return <LoadingScreen />;

  return (
    <main className="relative min-h-svh overflow-hidden bg-background">
      <img
        src={bg}
        alt=""
        width={1920}
        height={1200}
        className="pointer-events-none absolute inset-0 size-full object-cover"
      />
      <div className="pointer-events-none absolute inset-0 bg-background/50" />
      <div className="animate-float-slow pointer-events-none absolute -left-24 top-10 size-112 rounded-full bg-primary/20 blur-3xl" />
      <div className="animate-float-slow pointer-events-none absolute -right-24 bottom-0 size-128 rounded-full bg-accent/20 blur-3xl" />

      <div className="relative z-10 flex min-h-svh flex-col items-center justify-center px-4 py-10">
        <AnimatePresence mode="wait">
          {screen === "start" ? (
            <motion.div
              key="start"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="flex w-full flex-col items-center"
            >
              <StartScreen onGetStarted={() => setScreen("app")} />
            </motion.div>
          ) : (
            <motion.div
              key="app"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="flex w-full flex-col items-center"
            >
              <AppScreen onBack={() => setScreen("start")} />
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <Toast message={toastMessage} />
    </main>
  );
}

export default App;
