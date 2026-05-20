/**
 * First-time publish of the flicky Move package to Sui testnet.
 *
 *   bun run publish
 *
 * Reads deployer keypair from .env.local (SUI_DEPLOYER_PRIVATE_KEY) or falls
 * back to a clear error if not set. Writes captured ids into `deployed.json`.
 *
 * After publish, run `bun run codegen` to regenerate TS bindings into
 * apps/web/src/sui/gen.
 */
import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { config as loadEnv } from "dotenv";

import { SuiJsonRpcClient, getJsonRpcFullnodeUrl } from "@mysten/sui/jsonRpc";
import { Transaction } from "@mysten/sui/transactions";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";

// -----------------------------------------------------------------------------

loadEnv({ path: resolve(import.meta.dir, "../.env") });
loadEnv({ path: resolve(import.meta.dir, "../.env.local"), override: true });

const NETWORK = (process.env.SUI_NETWORK ?? "testnet") as
  | "testnet"
  | "mainnet"
  | "devnet"
  | "localnet";

const DEPLOYED_JSON = resolve(import.meta.dir, "../deployed.json");

// -----------------------------------------------------------------------------

async function main() {
  const keypair = loadDeployerKeypair();
  const address = keypair.toSuiAddress();
  const client = new SuiJsonRpcClient({
    url: process.env.SUI_RPC_URL ?? getJsonRpcFullnodeUrl(NETWORK),
    network: NETWORK,
  });

  console.log(`Deployer: ${address}`);
  console.log(`Network:  ${NETWORK}`);

  // 1. Compile + emit bytecode via the Sui CLI.
  const buildOutput = JSON.parse(
    execSync("sui move build --dump-bytecode-as-base64 --path .", {
      cwd: resolve(import.meta.dir, ".."),
    }).toString(),
  ) as { modules: string[]; dependencies: string[]; digest?: number[] };

  // The Move compiler tree-shakes the `deepbook` dep out of our publish list
  // because the local `deepbook_predict_min` stub doesn't actually `use
  // deepbook::*`. But the on-chain `deepbook_predict` package's linkage table
  // does — Sui's publish validator therefore requires the (upgraded) deepbook
  // address to appear in our publish deps. We inject it here per network.
  //
  // Latest deepbook published-at (read from deepbook_predict's on-chain
  // linkage table). Update when DeepBook upgrades again.
  const FORCE_INJECT_DEPS: Record<string, string[]> = {
    testnet: [
      "0x74cd5657843c627f3d80f713b71e9f895bbbeb470956d8a8e1185badf6cc77c8", // deepbook @ v19
    ],
  };
  for (const dep of FORCE_INJECT_DEPS[NETWORK] ?? []) {
    if (!buildOutput.dependencies.includes(dep)) {
      buildOutput.dependencies.push(dep);
    }
  }

  console.log(
    `Compiled ${buildOutput.modules.length} modules, ${buildOutput.dependencies.length} deps`,
  );

  // 2. Build the publish transaction.
  const tx = new Transaction();
  const upgradeCap = tx.publish({
    modules: buildOutput.modules,
    dependencies: buildOutput.dependencies,
  });
  tx.transferObjects([upgradeCap], address);
  tx.setSender(address);

  // 3. Execute.
  const result = await client.signAndExecuteTransaction({
    transaction: tx,
    signer: keypair,
    options: { showEffects: true, showObjectChanges: true },
  });

  if (result.effects?.status?.status !== "success") {
    console.error("Publish failed:", result.effects?.status);
    process.exit(1);
  }

  // 4. Extract packageId + UpgradeCap. Flicky has no `init` functions, so
  //    no extra shared objects/caps come out of the publish tx.
  const changes = result.objectChanges ?? [];
  const packageChange = changes.find((c) => c.type === "published") as
    | { packageId: string }
    | undefined;
  if (!packageChange) {
    console.error("No package id in objectChanges — aborting.");
    process.exit(1);
  }
  const packageId = packageChange.packageId;
  const upgradeCapId = findObjectId(changes, "0x2::package::UpgradeCap");

  if (!upgradeCapId) {
    console.error("UpgradeCap not in objectChanges — aborting.");
    process.exit(1);
  }

  const deployed = {
    network: NETWORK,
    packageId,
    originalPackageId: packageId,
    publishedAt: new Date().toISOString(),
    publishTxDigest: result.digest,
    publisherAddress: address,
    upgradeCap: upgradeCapId,
    notes: "Written by scripts/publish.ts. originalPackageId is preserved across upgrades.",
  };

  writeFileSync(DEPLOYED_JSON, JSON.stringify(deployed, null, 2) + "\n");
  console.log(`\nWrote ${DEPLOYED_JSON}`);
  console.log(deployed);
}

// -----------------------------------------------------------------------------

function loadDeployerKeypair(): Ed25519Keypair {
  const privKey = process.env.SUI_DEPLOYER_PRIVATE_KEY;
  if (!privKey) {
    console.error(
      "SUI_DEPLOYER_PRIVATE_KEY not set. Export your active key:\n" +
        "  sui keytool export --key-identity $(sui client active-address)\n" +
        "and paste it into apps/contracts/.env.local as SUI_DEPLOYER_PRIVATE_KEY.",
    );
    process.exit(1);
  }
  const { secretKey } = decodeSuiPrivateKey(privKey);
  return Ed25519Keypair.fromSecretKey(secretKey);
}

function findObjectId(changes: any[], objectType: string): string | null {
  const found = changes.find(
    (c) => c.type === "created" && c.objectType === objectType,
  ) as { objectId: string } | undefined;
  return found?.objectId ?? null;
}

// -----------------------------------------------------------------------------

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
