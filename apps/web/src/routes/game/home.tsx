import { MatchButton } from "@/components/match-button"

export default function GameHome() {
  return (
    <div className="flex flex-col items-center gap-6 px-4 py-6">
      <h2 className="text-xs uppercase tracking-widest text-white/60">home</h2>
      <div className="grid h-48 w-48 place-items-center rounded-2xl bg-amber-200/90 text-4xl text-amber-900">
        ☻
      </div>
      <div className="flex w-full flex-col gap-3">
        <MatchButton
          label="Find Match"
          stake={
            <>
              <span className="text-[10px] font-black leading-none text-white">
                $
              </span>
              <span className="-translate-y-px text-sm font-black leading-none tabular-nums text-white">
                3
              </span>
              <ChevronDown />
            </>
          }
        />
        <MatchButton label="Practice" />
      </div>
    </div>
  )
}

function ChevronDown() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="-ml-0.5 size-3 text-white/85"
      aria-hidden
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  )
}
