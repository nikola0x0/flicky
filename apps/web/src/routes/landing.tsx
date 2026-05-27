import { Link } from "react-router"

export default function Landing() {
  return (
    <div className="min-h-dvh w-full bg-background text-foreground font-display">
      <div className="mx-auto flex min-h-dvh max-w-3xl flex-col items-center justify-center px-6 text-center">
        <h1 className="text-6xl tracking-tight md:text-8xl">flicky</h1>
        <p className="mt-4 max-w-md text-balance text-ink-subtle">
          Tinder-style PvP prediction duels on Sui. Swipe YES/NO, mint real
          Predict positions, take the pot.
        </p>
        <Link
          to="/game/home"
          className="mt-10 rounded-full bg-primary px-6 py-3 text-base text-primary-foreground hover:opacity-90"
        >
          enter the game →
        </Link>
      </div>
    </div>
  )
}
