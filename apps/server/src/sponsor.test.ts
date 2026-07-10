/**
 * Sponsor allowlist + CORS + origin gating. Pure functions, no network.
 *
 * Most behaviour gates on `env.allowedOrigin` which is captured at
 * module load. Tests mutate `process.env.ALLOWED_ORIGIN` BEFORE the
 * first dynamic import so the value lands; subsequent re-imports reuse
 * the cached env unless we force-reset. Bun caches modules per-test-file
 * so a single suite is enough.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"

let sponsor: typeof import("./sponsor")

const originalAllowedOrigin = process.env.ALLOWED_ORIGIN
const originalFlickyMainnet = process.env.FLICKY_PACKAGE_MAINNET
const originalAccountMainnet = process.env.ACCOUNT_PACKAGE_MAINNET
const originalDeepbookMainnet = process.env.DEEPBOOK_PREDICT_PACKAGE_MAINNET

beforeAll(async () => {
  // Default to wildcard so the broad CORS path is exercised.
  delete process.env.ALLOWED_ORIGIN
  sponsor = await import("./sponsor")
})

afterAll(() => {
  if (originalAllowedOrigin === undefined) delete process.env.ALLOWED_ORIGIN
  else process.env.ALLOWED_ORIGIN = originalAllowedOrigin
  if (originalFlickyMainnet === undefined) delete process.env.FLICKY_PACKAGE_MAINNET
  else process.env.FLICKY_PACKAGE_MAINNET = originalFlickyMainnet
  if (originalAccountMainnet === undefined) delete process.env.ACCOUNT_PACKAGE_MAINNET
  else process.env.ACCOUNT_PACKAGE_MAINNET = originalAccountMainnet
  if (originalDeepbookMainnet === undefined) delete process.env.DEEPBOOK_PREDICT_PACKAGE_MAINNET
  else process.env.DEEPBOOK_PREDICT_PACKAGE_MAINNET = originalDeepbookMainnet
})

describe("buildAllowedTargets", () => {
  test("allowlist covers 6-24 account + expiry_market targets, not 4-16 predict", () => {
    const targets = sponsor.buildAllowedTargets("testnet")
    expect(targets).toContain(`${sponsor.env.accountPackageId}::account_registry::new`)
    expect(targets).toContain(`${sponsor.env.accountPackageId}::account::deposit_funds`)
    expect(targets).toContain(`${sponsor.env.deepbookPredictPackageId}::expiry_market::mint_exact_quantity`)
    expect(targets).toContain(`${sponsor.env.flickyPackageId}::duel::finalize_test_one_price`)
    expect(targets.some((t) => t.includes("::predict::mint"))).toBe(false)
    expect(targets.some((t) => t.includes("finalize_test_one_oracle"))).toBe(false)
  })

  test("testnet — covers every flicky duel entry + every DeepBook fn", () => {
    const targets = sponsor.buildAllowedTargets("testnet")
    // flicky duel functions (swap is a separate package — checked below)
    const expectedFlickyFns = [
      "duel::new_card",
      "duel::create_duel",
      "duel::create_duel_free",
      "duel::join_duel",
      "duel::join_duel_free",
      "duel::reveal_deck",
      "duel::record_swipe",
      "duel::record_swipe_free",
      "duel::claim_reveal_timeout",
      "duel::refund_duel",
      "duel::settle_card",
      "duel::settle_card_free",
      "duel::finalize",
      "duel::finalize_free",
      "duel::finalize_test_one_price",
    ]
    for (const fn of expectedFlickyFns) {
      const matching = targets.filter((t) => t.endsWith(`::${fn}`))
      expect(matching).toHaveLength(1)
    }
    // Account functions allowlisted under the account package.
    const expectedAccountFns = [
      "account_registry::new",
      "account::share",
      "account::generate_auth",
      "account::deposit_funds",
      "account::withdraw_funds",
    ]
    for (const fn of expectedAccountFns) {
      const matching = targets.filter((t) => t.endsWith(`::${fn}`))
      expect(matching).toHaveLength(1)
    }
    // Swap functions allowlisted under the SEPARATE swap package.
    const swapTargets = targets.filter(
      (t) => t.includes("::swap::") && t.startsWith("0x51ea0f29"),
    )
    expect(swapTargets.map((t) => t.split("::").slice(1).join("::"))).toEqual(
      expect.arrayContaining(["swap::swap_x_for_y", "swap::swap_y_for_x"]),
    )
    // DeepBook Predict functions (6-24 set)
    const expectedDeepbookFns = [
      "expiry_market::load_live_pricer",
      "expiry_market::mint_exact_quantity",
      "expiry_market::mint_exact_amount",
      "expiry_market::redeem_live",
    ]
    for (const fn of expectedDeepbookFns) {
      const matching = targets.filter((t) => t.endsWith(`::${fn}`))
      expect(matching).toHaveLength(1)
    }
  })

  test("testnet — every target is fully-qualified 0x…::module::fn", () => {
    const targets = sponsor.buildAllowedTargets("testnet")
    for (const t of targets) {
      expect(t).toMatch(/^0x[0-9a-fA-F]+::[a-z_0-9]+::[a-z_0-9]+$/)
    }
  })

  test("mainnet — throws clearly when FLICKY_PACKAGE_MAINNET unset", () => {
    delete process.env.FLICKY_PACKAGE_MAINNET
    expect(() => sponsor.buildAllowedTargets("mainnet")).toThrow(
      /FLICKY_PACKAGE_MAINNET/,
    )
  })

  test("mainnet — throws clearly when ACCOUNT_PACKAGE_MAINNET unset", () => {
    delete process.env.ACCOUNT_PACKAGE_MAINNET
    // Set flicky to pass first check
    process.env.FLICKY_PACKAGE_MAINNET = "0xflickymainnetpkg"
    expect(() => sponsor.buildAllowedTargets("mainnet")).toThrow(
      /ACCOUNT_PACKAGE_MAINNET/,
    )
  })

  test("mainnet — throws clearly when DEEPBOOK_PREDICT_PACKAGE_MAINNET unset", () => {
    delete process.env.DEEPBOOK_PREDICT_PACKAGE_MAINNET
    // Set flicky and account to pass first checks
    process.env.FLICKY_PACKAGE_MAINNET = "0xflickymainnetpkg"
    process.env.ACCOUNT_PACKAGE_MAINNET = "0xaccountmainnetpkg"
    expect(() => sponsor.buildAllowedTargets("mainnet")).toThrow(
      /DEEPBOOK_PREDICT_PACKAGE_MAINNET/,
    )
  })

  test("mainnet — succeeds when all three env overrides are set", () => {
    process.env.FLICKY_PACKAGE_MAINNET = "0xflickymainnetpkg"
    process.env.ACCOUNT_PACKAGE_MAINNET = "0xaccountmainnetpkg"
    process.env.DEEPBOOK_PREDICT_PACKAGE_MAINNET = "0xdeepbookmainnetpkg"
    const targets = sponsor.buildAllowedTargets("mainnet")
    expect(targets.length).toBeGreaterThan(0)
    expect(targets.some((t) => t.startsWith("0xflickymainnetpkg::"))).toBe(true)
    expect(targets.some((t) => t.startsWith("0xaccountmainnetpkg::"))).toBe(true)
    expect(targets.some((t) => t.startsWith("0xdeepbookmainnetpkg::"))).toBe(true)
  })
})

describe("sponsorCorsHeaders", () => {
  test("ALLOWED_ORIGIN unset → echoes request origin, falls back to '*'", () => {
    const h = sponsor.sponsorCorsHeaders("https://flicky.app")
    expect(h["Access-Control-Allow-Origin"]).toBe("https://flicky.app")
    const h2 = sponsor.sponsorCorsHeaders(null)
    expect(h2["Access-Control-Allow-Origin"]).toBe("*")
  })

  test("always includes Vary: Origin and POST,OPTIONS methods", () => {
    const h = sponsor.sponsorCorsHeaders("https://anywhere.example")
    expect(h["Access-Control-Allow-Methods"]).toContain("POST")
    expect(h["Access-Control-Allow-Methods"]).toContain("OPTIONS")
    expect(h.Vary).toBe("Origin")
  })
})

describe("isSponsorOriginAllowed", () => {
  test("ALLOWED_ORIGIN unset → all origins allowed", () => {
    expect(sponsor.isSponsorOriginAllowed("https://anywhere.example")).toBe(true)
    expect(sponsor.isSponsorOriginAllowed(null)).toBe(true)
  })

  // We can't re-import the module to flip ALLOWED_ORIGIN because env is
  // captured at module load. Behaviour with a configured allowlist is
  // covered by the request-handling integration tests + manual QA.
})
