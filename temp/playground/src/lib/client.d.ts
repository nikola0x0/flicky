import { SuiJsonRpcClient } from '@mysten/sui/jsonRpc';
export declare const client: SuiJsonRpcClient;
export declare const getSuiClient: () => SuiJsonRpcClient;
export declare const parseResult: (returnValues: Array<Array<number>> | null | undefined) => string | null;
