/**
 * Upgrade the deployed flicky package, preserving `originalPackageId`.
 *
 *   bun run upgrade
 *
 * Reads ids from `deployed.json`, compiles current Move sources, submits an
 * upgrade tx using the saved UpgradeCap, writes the NEW packageId back and
 * mirrors it into apps/web/.env.local for the dev server.
 */
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { config as loadEnv } from "dotenv";

import { SuiJsonRpcClient, getJsonRpcFullnodeUrl } from "@mysten/sui/jsonRpc";
import { Transaction, UpgradePolicy } from "@mysten/sui/transactions";
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
  const deployed = JSON.parse(readFileSync(DEPLOYED_JSON, "utf-8"));
  if (!deployed.packageId || !deployed.upgradeCap) {
    throw new Error(
      "deployed.json missing packageId or upgradeCap. Run publish first.",
    );
  }

  const keypair = loadDeployerKeypair();
  const address = keypair.toSuiAddress();
  const client = new SuiJsonRpcClient({
    url: process.env.SUI_RPC_URL ?? getJsonRpcFullnodeUrl(NETWORK),
    network: NETWORK,
  });

  console.log(`Deployer:             ${address}`);
  console.log(`Network:              ${NETWORK}`);
  console.log(`Current packageId:    ${deployed.packageId}`);
  console.log(`Original packageId:   ${deployed.originalPackageId}`);

  // 1. Compile.
  const buildOutput = JSON.parse(
    execSync("sui move build --dump-bytecode-as-base64 --path .", {
      cwd: resolve(import.meta.dir, ".."),
      env: { ...process.env, PATH: `/opt/homebrew/bin:${process.env.PATH}` },
    }).toString(),
  ) as { modules: string[]; dependencies: string[]; digest: number[] };

  console.log(
    `Compiled ${buildOutput.modules.length} modules, ${buildOutput.dependencies.length} deps:`,
    JSON.stringify(buildOutput.dependencies, null, 2)
  );

  // 2. Build upgrade tx.
  const tx = new Transaction();
  const ticket = tx.moveCall({
    target: "0x2::package::authorize_upgrade",
    arguments: [
      tx.object(deployed.upgradeCap),
      tx.pure.u8(UpgradePolicy.COMPATIBLE),
      tx.pure.vector("u8", buildOutput.digest),
    ],
  });
  const receipt = tx.upgrade({
    modules: buildOutput.modules,
    dependencies: buildOutput.dependencies,
    package: deployed.packageId,
    ticket,
  });
  tx.moveCall({
    target: "0x2::package::commit_upgrade",
    arguments: [tx.object(deployed.upgradeCap), receipt],
  });
  tx.setSender(address);

  // 3. Execute.
  const result = await client.signAndExecuteTransaction({
    transaction: tx,
    signer: keypair,
    options: { showEffects: true, showObjectChanges: true },
  });

  if (result.effects?.status?.status !== "success") {
    console.error("Upgrade failed:", result.effects?.status);
    process.exit(1);
  }

  // 4. Extract new packageId.
  const changes = result.objectChanges ?? [];
  const packageChange = changes.find((c) => c.type === "published") as
    | { packageId: string }
    | undefined;
  if (!packageChange) {
    console.error("No new package id in objectChanges — aborting.");
    process.exit(1);
  }

  const updated = {
    ...deployed,
    packageId: packageChange.packageId,
    // originalPackageId is preserved verbatim from the existing file.
    previousPackageId: deployed.packageId,
    lastUpgradeAt: new Date().toISOString(),
    lastUpgradeTxDigest: result.digest,
  };

  writeFileSync(DEPLOYED_JSON, JSON.stringify(updated, null, 2) + "\n");
  console.log(`\nUpgraded. New packageId: ${packageChange.packageId}`);
  console.log(`Original (stable):       ${deployed.originalPackageId}`);
  console.log(`Wrote ${DEPLOYED_JSON}`);

  // Mirror packageId into apps/web/.env.local so Vite picks up the new id
  // without a manual paste step. originalPackageId never changes — only the
  // bumped packageId is written here.
  const envPath = resolve(import.meta.dir, "../../web/.env.local");
  const envKey = `VITE_FLICKY_PACKAGE_ID_${NETWORK.toUpperCase()}`;
  const wrote = upsertEnvVar(envPath, envKey, packageChange.packageId);
  console.log(`Wrote env:               ${envPath} :: ${envKey} (${wrote})`);
}

function upsertEnvVar(envPath: string, key: string, value: string): string {
  if (!existsSync(envPath)) {
    writeFileSync(envPath, `${key}=${value}\n`);
    return "missing-file → created";
  }
  const original = readFileSync(envPath, "utf-8");
  const re = new RegExp(`^${key}=.*$`, "m");
  if (re.test(original)) {
    writeFileSync(envPath, original.replace(re, `${key}=${value}`));
    return "updated";
  }
  const suffix = original.endsWith("\n") ? "" : "\n";
  writeFileSync(envPath, `${original}${suffix}${key}=${value}\n`);
  return "appended";
}

// -----------------------------------------------------------------------------

function loadDeployerKeypair(): Ed25519Keypair {
  const privKey = process.env.SUI_DEPLOYER_PRIVATE_KEY;
  if (!privKey) {
    console.error(
      "SUI_DEPLOYER_PRIVATE_KEY required for upgrade (needs to own the UpgradeCap).",
    );
    process.exit(1);
  }
  const { secretKey } = decodeSuiPrivateKey(privKey);
  return Ed25519Keypair.fromSecretKey(secretKey);
}

// -----------------------------------------------------------------------------

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
