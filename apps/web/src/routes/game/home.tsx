import { MyMatchTile } from "@/components/my-match-tile"

export default function GameHome() {
  return (
    <div className="flex flex-col items-center gap-6 px-4 py-6">
      <h2 className="text-sm tracking-widest text-white/60 uppercase">home</h2>
      <MyMatchTile />
    </div>
  )
}
