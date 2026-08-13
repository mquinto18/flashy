import { ArrowRight } from "lucide-react";
import { FlashyIsland } from "../components/FlashyIsland";

interface AppScreenProps {
  onBack: () => void;
}

export function AppScreen({ onBack }: AppScreenProps) {
  return (
    <div className="relative z-10 flex w-full flex-col items-center px-4 pt-6 pb-16 sm:pt-8">
      <FlashyIsland />

      <section className="mt-20 max-w-xl text-center">
        <h1 className="text-3xl font-semibold text-foreground sm:text-4xl">
          Start your work in <span className="text-brand-gradient">one click</span>
        </h1>
        <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
          Flashy lives at the top of your screen. Build a category, fill it with the apps, websites,
          files and folders you always use, then launch the whole set at once.
        </p>
      </section>

      <button
        type="button"
        onClick={onBack}
        className="glass mt-10 inline-flex items-center gap-2 rounded-full px-5 py-2.5 text-sm font-semibold text-foreground transition-all duration-300 hover:-translate-y-0.5 hover:border-primary/40"
      >
        <ArrowRight className="size-4 rotate-180" />
        Back to start
      </button>
    </div>
  );
}
