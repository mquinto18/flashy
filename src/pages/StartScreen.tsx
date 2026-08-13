import { ArrowRight, Sparkles } from "lucide-react";
import logo from "../assets/flashy-logo.png";

interface StartScreenProps {
  onGetStarted: () => void;
}

export function StartScreen({ onGetStarted }: StartScreenProps) {
  return (
    <div className="relative z-10 flex w-full max-w-md flex-col items-center px-4 text-center">
      <div className="animate-island-drop glass-strong flex items-center gap-3 rounded-full py-2.5 pl-2.5 pr-5">
        <img
          src={logo}
          alt="Flashy logo"
          width={48}
          height={48}
          className="size-12 drop-shadow-[0_0_18px_oklch(0.85_0.13_195/0.5)]"
        />
        <span className="text-lg font-semibold tracking-tight text-foreground">Flashy</span>
      </div>

      <h1 className="animate-island-drop mt-8 text-4xl font-semibold text-foreground sm:text-5xl">
        Launch your whole <span className="text-brand-gradient">workspace</span> in one click
      </h1>
      <p className="animate-island-drop mt-4 max-w-sm text-sm leading-relaxed text-muted-foreground">
        Group the apps, websites, files and folders you use every day into a single workspace — then
        open them all at once. Less setup, more flow.
      </p>

      <div className="animate-island-drop mt-10 flex w-full flex-col items-center gap-3">
        <button
          type="button"
          onClick={onGetStarted}
          className="bg-brand-gradient group flex w-full items-center justify-center gap-2 rounded-full py-4 text-base font-semibold text-primary-foreground transition-transform duration-300 hover:scale-[1.02] active:scale-[0.99]"
        >
          <Sparkles className="size-4" />
          Get started
          <ArrowRight className="size-4 transition-transform duration-300 group-hover:translate-x-1" />
        </button>
        <p className="text-xs text-muted-foreground">No sign-up · Works with what you already use</p>
      </div>
    </div>
  );
}
