export default function GamePvp() {
  return (
    <div className="flex flex-col gap-4 px-4 py-6">
      <h2 className="text-xs uppercase tracking-widest text-white/60">pvp</h2>
      <p className="text-sm text-white/70">
        Pick a stake tier and queue. Match starts when an opponent joins.
      </p>
      <div className="grid grid-cols-2 gap-2">
        {[1, 3, 5, 10].map((d) => (
          <button
            key={d}
            className="rounded-xl bg-white/5 px-3 py-4 text-center hover:bg-white/10"
          >
            <div className="text-2xl">${d}</div>
            <div className="text-[10px] uppercase tracking-wider text-white/50">
              dUSDC
            </div>
          </button>
        ))}
      </div>
    </div>
  )
}
