/**
 * Dedicated OAuth callback target.
 *
 * Enoki opens sign-in in a popup, polls the popup's URL for the OAuth
 * response, then closes it. So this page is only ever rendered inside
 * the popup, for the brief moment between the OAuth redirect landing
 * and Enoki detecting the hash/search params and closing the popup.
 *
 * It MUST exist on the same origin as the parent (so cross-origin
 * policies don't block popup.location reads) and MUST be the value
 * registered in Google Cloud Console → Authorized redirect URIs.
 * That's the only contract — what it renders is irrelevant.
 */
export default function AuthCallback() {
  return (
    <div className="grid min-h-dvh place-items-center bg-[#1b2548] text-white font-display">
      <p className="text-base uppercase tracking-widest opacity-70">
        signing you in…
      </p>
    </div>
  )
}
