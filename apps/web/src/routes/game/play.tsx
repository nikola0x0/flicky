/**
 * `/game/play/:duelId` — deep-linkable, reload-safe live gameplay.
 *
 * Unlike the matchmaking entry (`/game/pvp`), this route rehydrates the
 * live duel purely from its id: it derives the player's PredictManager and
 * verifies participation on-chain, then mounts `ActiveDuel` in resume mode
 * (subscribe to the room, let `room_state` drive the phase). Reloading or
 * sharing the URL just works.
 *
 * Guards: a finished duel or a non-participant is sent to the read-only
 * result screen (`/game/duel/:id`) — only live participants may mint here.
 */
import { useEffect, useState, type ReactNode } from "react"
import { Navigate, useNavigate, useParams } from "react-router"
import { useCurrentAccount, useSuiClient } from "@mysten/dapp-kit"

import { useFlickySocket } from "@/hooks/use-flicky-socket"
import { findPredictManager } from "@/lib/deepbook"
import { fetchDuel } from "@/lib/flicky"
import { ActiveDuel } from "./active-duel"

type Load =
  | { kind: "loading" }
  | { kind: "redirect" }
  | { kind: "error"; message: string }
  | { kind: "ready"; managerId: string }

export default function PlayDuel() {
  const { duelId } = useParams<{ duelId: string }>()
  const navigate = useNavigate()
  const account = useCurrentAccount()
  const client = useSuiClient()
  const { wsOpen, send, onMessage } = useFlickySocket(account?.address)
  const [load, setLoad] = useState<Load>({ kind: "loading" })

  useEffect(() => {
    if (!duelId || !account) return
    let cancelled = false
    const me = account.address.toLowerCase()
    let attempt = 0
    const attemptLoad = async () => {
      try {
        const [duel, manager] = await Promise.all([
          fetchDuel(client, duelId),
          findPredictManager(client, account.address),
        ])
        if (cancelled) return
        // Finished duels are read-only — straight to the result screen.
        if (duel.status === "COMPLETE") {
          setLoad({ kind: "redirect" })
          return
        }
        const isParticipant =
          duel.creator.toLowerCase() === me ||
          duel.challenger.toLowerCase() === me
        if (isParticipant && manager) {
          setLoad({ kind: "ready", managerId: manager.id })
          return
        }
        // Read-after-write race: a just-joined challenger's `challenger`
        // field (or a freshly created manager) may not be reflected on the
        // fullnode yet. Retry a few times before treating them as a
        // spectator and bouncing to the read-only result.
        if (attempt < 6) {
          attempt++
          setTimeout(attemptLoad, 800)
          return
        }
        setLoad({ kind: "redirect" })
      } catch (e) {
        if (cancelled) return
        // The Duel object may not be queryable yet right after create —
        // retry before surfacing the error.
        if (attempt < 6) {
          attempt++
          setTimeout(attemptLoad, 800)
          return
        }
        setLoad({
          kind: "error",
          message: e instanceof Error ? e.message : String(e),
        })
      }
    }
    void attemptLoad()
    return () => {
      cancelled = true
    }
  }, [duelId, account, client])

  if (!duelId) return <Navigate to="/game/home" replace />
  if (!account)
    return <Centered>connect your wallet to resume this duel.</Centered>
  if (load.kind === "redirect")
    return <Navigate to={`/game/duel/${duelId}`} replace />
  if (load.kind === "error")
    return <Centered>couldn&rsquo;t load duel — {load.message}</Centered>
  if (load.kind === "loading" || !wsOpen)
    return <Centered>resuming duel&hellip;</Centered>

  return (
    <ActiveDuel
      resumeDuelId={duelId}
      managerId={load.managerId}
      wsOpen={wsOpen}
      send={send}
      onMessage={onMessage}
      onExit={() => navigate("/game/home")}
    />
  )
}

function Centered({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center px-4 py-10 text-center text-base text-white/60">
      {children}
    </div>
  )
}
