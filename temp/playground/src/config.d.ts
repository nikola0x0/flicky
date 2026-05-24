export declare const CONFIG: {
    readonly network: "testnet" | "mainnet";
    readonly rpcUrl: any;
    readonly predictPackageId: any;
    readonly registryId: any;
    readonly predictObjectId: any;
    readonly flickyPackageId: any;
    readonly marketOracleId: any;
    readonly pythSourceId: any;
    readonly dusdcPackageId: any;
    readonly CLOCK_ID: "0x6";
    readonly ONE_E9: 1000000000n;
    readonly U64_MAX: 18446744073709551615n;
    readonly NEG_INF_STRIKE: 0n;
    readonly POS_INF_STRIKE: 18446744073709551615n;
};
export declare const DUSDC_TYPE: (packageId: string) => string;
export declare const PLPCoin: (packageId: string) => string;
export declare const getModuleAddress: (target: string) => string;
