# Contract Information

URL: https://docs.sui.io/onchain-finance/deepbook-predict/contract-information

This page contains the current public integration targets forDeepBook **DeepBook** A decentralized central limit order book (CLOB) built on Sui. Predict on SuiTestnet **Testnet** Staging network for testing changes before production deployment. . These values come from the `predict-testnet-4-16` branch of the [DeepBookV3 Predict package](https://github.com/MystenLabs/deepbookv3/tree/predict-testnet-4-16/packages/predict) .

caution
DeepBook Predict is documented here as aTestnet integration surface. The smart contracts might change beforeMainnet **Mainnet** Production network for live transactions and real-value assets. deployment, so treat the currentpackage **Package** Smart contracts on Sui. IDs,object **Object** The basic unit of storage on Sui. layouts, and entry points as provisional. Ignore older Predictpackage IDs in local configs or scripts unless a newer deployment explicitly replaces the values below.

## Current deployment

| Parameter | Value 
| Network | Testnet 
| Public server | `https://predict-server.testnet.mystenlabs.com` 
| Predictpackage | `0xf5ea2b3749c65d6e56507cc35388719aadb28f9cab873696a2f8687f5c785138` 
| Predict registry | `0x43af14fed5480c20ff77e2263d5f794c35b9fab7e2212903127062f4fe2a6e64` 
| Predictobject | `0xc8736204d12f0a7277c86388a68bf8a194b0a14c5538ad13f22cbd8e2a38028a` 
| Current quote asset | `0xe95040085976bfd54a1a07225cd46c8a2b4e8e2b6732f140a0fc49850ba73e1a::dusdc::DUSDC` 
| PLP coin type | `0xf5ea2b3749c65d6e56507cc35388719aadb28f9cab873696a2f8687f5c785138::plp::PLP` 
| Source branch | [`predict-testnet-4-16`](https://github.com/MystenLabs/deepbookv3/tree/predict-testnet-4-16/packages/predict) 

## Supported quote assets

Click to open DeepBook Test USDC (DUSDC)
| Parameter | Value 
| Type | `0xe95040085976bfd54a1a07225cd46c8a2b4e8e2b6732f140a0fc49850ba73e1a::dusdc::DUSDC` 
| Currency ID | `0xf3000dff421833d4bb8ed58fac146d691a3aaba2785aa1989af65a7089ca3e9c` 
| Decimals | 6 
| Network | Testnet 

## Public server endpoints

The public server base URL is `https://predict-server.testnet.mystenlabs.com` . Use it to retrieve render-ready market, vault, portfolio, and history data.

The following example queries the market state for a Predictobject :

```bash
$ curl https://predict-server.testnet.mystenlabs.com/predicts/0xc8736204d12f0a7277c86388a68bf8a194b0a14c5538ad13f22cbd8e2a38028a/state
```

### Protocol and market state

| Endpoint | Use 
| `GET /status` | Server health and status 
| `GET /predicts/:predict_id/state` | Predictobject state and config 
| `GET /predicts/:predict_id/oracles` | Oracle list for a Predictobject 
| `GET /oracles/:oracle_id/state` | Current oracle state 
| `GET /predicts/:predict_id/quote-assets` | Accepted quote assets 
| `GET /oracles/:oracle_id/ask-bounds` | Resolved oracle ask bounds 

### Vault and LP data

| Endpoint | Use 
| `GET /predicts/:predict_id/vault/summary` | Current vault summary 
| `GET /predicts/:predict_id/vault/performance?range=ALL` | Vault performance over a selected range 
| `GET /lp/supplies` | LP supply history 
| `GET /lp/withdrawals` | LP withdrawal history 

### Manager and portfolio data

| Endpoint | Use 
| `GET /managers` | Predict manager list 
| `GET /managers/:manager_id/summary` | Manager summary 
| `GET /managers/:manager_id/positions/summary` | Manager position summary 
| `GET /managers/:manager_id/pnl?range=ALL` | Manager PnL over a selected range 

### History data

| Endpoint | Use 
| `GET /oracles/:oracle_id/prices` | Oracle price history 
| `GET /oracles/:oracle_id/prices/latest` | Latest indexed price update 
| `GET /oracles/:oracle_id/svi` | Oracle SVI history 
| `GET /oracles/:oracle_id/svi/latest` | Latest indexed SVI update 
| `GET /positions/minted` | Position mint history 
| `GET /positions/redeemed` | Position redeem history 
| `GET /ranges/minted` | Range mint history 
| `GET /ranges/redeemed` | Range redeem history 
| `GET /trades/:oracle_id` | Trade history for an oracle 

## Live Sui events

When a UI needs lower-latency oracle state than the indexed server provides, use Suicheckpoint **Checkpoint** Created after transaction execution to provide a certified record of chain history. or event streaming. Filter by the current Predictpackage ID and watch these event types:

- `oracle::OraclePricesUpdated`
- `oracle::OracleSVIUpdated`
- `oracle::OracleSettled`
- `oracle::OracleActivated`
Use the server for historical pagination. Use the live stream for freshness.

## Source pointers

| Area | Source 
| Core sharedobject | [`packages/predict/sources/predict.move`](https://github.com/MystenLabs/deepbookv3/blob/predict-testnet-4-16/packages/predict/sources/predict.move) 
| Manager account model | [`packages/predict/sources/predict_manager.move`](https://github.com/MystenLabs/deepbookv3/blob/predict-testnet-4-16/packages/predict/sources/predict_manager.move) 
| Registry and admin entry points | [`packages/predict/sources/registry.move`](https://github.com/MystenLabs/deepbookv3/blob/predict-testnet-4-16/packages/predict/sources/registry.move) 
| Oracle state machine | [`packages/predict/sources/oracle.move`](https://github.com/MystenLabs/deepbookv3/blob/predict-testnet-4-16/packages/predict/sources/oracle.move) 
| Vault accounting | [`packages/predict/sources/vault/vault.move`](https://github.com/MystenLabs/deepbookv3/blob/predict-testnet-4-16/packages/predict/sources/vault/vault.move) 

[## Predict

Learn about the Predict shared object, public trading functions, liquidity functions, configuration reads, and emitted events.

→](/onchain-finance/deepbook-predict/contract-information/predict)
[## Predict Manager

Learn about PredictManager accounts, deposited quote balances, binary position quantities, and range quantities.

→](/onchain-finance/deepbook-predict/contract-information/predict-manager)
[## Market Keys

Learn how DeepBook Predict identifies binary positions and vertical ranges with MarketKey and RangeKey.

→](/onchain-finance/deepbook-predict/contract-information/market-keys)
[## Oracle

Learn about OracleSVI lifecycle, price updates, SVI updates, settlement, and oracle read functions in DeepBook Predict.

→](/onchain-finance/deepbook-predict/contract-information/oracle)
[## Vault

Learn about the DeepBook Predict vault, PLP shares, vault value, exposure tracking, and liquidity reads.

→](/onchain-finance/deepbook-predict/contract-information/vault)
[## Registry

Learn about DeepBook Predict registry setup, oracle creation, quote asset management, and admin configuration entry points.

→](/onchain-finance/deepbook-predict/contract-information/registry)