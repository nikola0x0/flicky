export default function GameShop() {
  return (
    <div className="flex flex-col gap-4 px-4 py-6">
      <h2 className="text-xs uppercase tracking-widest text-white/60">shop</h2>
      <p className="text-sm text-white/70">
        Deposit dUSDC, swap SUI → dUSDC (1:10), buy cosmetics.
      </p>
      <div className="grid grid-cols-2 gap-3">
        {["deposit", "swap", "skins", "boosters"].map((tile) => (
          <div
            key={tile}
            className="aspect-square rounded-xl bg-white/5 p-3 text-[10px] uppercase tracking-widest text-white/70"
          >
            {tile}
          </div>
        ))}
      </div>
    </div>
  )
}
